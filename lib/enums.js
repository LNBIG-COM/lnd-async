// Enum values the protos of the line do not have. With `enums: String` protobufjs 6 decodes them
// into undefined (protobufjs 7 keeps the number), so a node newer than the line loses data: the
// CHANNEL_UPDATE event of LND 0.21 came to a client of the 0.20 line as { type: undefined }.
// The response deserializers of proto-loader are wrapped: a response is decoded by proto-loader
// as before, and only when it holds such a value it is decoded again to put the number in place.
const protobuf = require('protobufjs');

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isEnum = field => field.resolvedType instanceof protobuf.Enum;

let plansByRoot = new WeakMap();

/**
 * For every message type of `root` that can hold an enum, directly or in a nested message, its
 * plan: the fields to look at, { name, isEnum, isList, plan } where `plan` is the plan of the
 * type of a message field. Everything is worked out here, as responses are walked per element.
 * @returns {Map<protobuf.Type, Object[]>}
 */
function enumPlans(root) {
  if (!plansByRoot.has(root)) {
    let types = [];
    (function collect(ns) {
      for (let obj of ns.nestedArray || []) {
        if (obj instanceof protobuf.Type) types.push(obj);
        collect(obj);
      }
    })(root);
    // A fixed point, because messages can refer to each other in a cycle
    let reaching = new Set(types.filter(type => type.fieldsArray.some(isEnum)));
    for (let changed = true; changed; ) {
      changed = false;
      for (let type of types) {
        if (!reaching.has(type) && type.fieldsArray.some(f => reaching.has(f.resolvedType))) {
          reaching.add(type);
          changed = true;
        }
      }
    }
    let plans = new Map([...reaching].map(type => [type, []]));
    for (let [type, plan] of plans) {
      for (let field of type.fieldsArray) {
        if (isEnum(field) || plans.has(field.resolvedType)) {
          plan.push({
            name: field.name,
            isEnum: isEnum(field),
            isList: Boolean(field.map || field.repeated),
            plan: plans.get(field.resolvedType),
          });
        }
      }
    }
    plansByRoot.set(root, plans);
  }
  return plansByRoot.get(root);
}

// The values of a repeated field (an array) or of a map (an object)
const items = value => (Array.isArray(value) ? value : Object.values(value));

/** Whether `object`, decoded with `plan`, holds an enum value decoded into undefined. */
function hasUnknown(plan, object) {
  for (let entry of plan) {
    let value = object[entry.name];
    if (entry.isEnum) {
      if (entry.isList) {
        if (value && items(value).includes(undefined)) return true;
      } else if (value === undefined && has(object, entry.name)) {
        return true;
      }
    } else if (value) {
      if (entry.isList) {
        for (let item of items(value)) if (hasUnknown(entry.plan, item)) return true;
      } else if (hasUnknown(entry.plan, value)) {
        return true;
      }
    }
  }
  return false;
}

/** Replaces undefined enum values of `object` with the numbers of `message`, the same data. */
function restore(plan, object, message) {
  for (let entry of plan) {
    let value = object[entry.name];
    let raw = message[entry.name];
    if (entry.isEnum) {
      if (entry.isList) {
        for (let key of Object.keys(value || {})) {
          if (value[key] === undefined) value[key] = raw[key];
        }
      } else if (value === undefined && has(object, entry.name)) {
        object[entry.name] = raw;
      }
    } else if (value) {
      if (entry.isList) {
        for (let key of Object.keys(value)) restore(entry.plan, value[key], raw[key]);
      } else {
        restore(entry.plan, value, raw);
      }
    }
  }
}

/**
 * Wraps a deserializer of `type` (from a root with the same protos) so that unknown enum values
 * come out as numbers. Returns `deserialize` itself when the type cannot hold an enum.
 */
function keepUnknownEnums(deserialize, type) {
  let plan = enumPlans(type.root).get(type);
  if (!plan) return deserialize;
  return function deserializeKeepingUnknownEnums(buffer) {
    let object = deserialize(buffer);
    if (hasUnknown(plan, object)) restore(plan, object, type.decode(buffer));
    return object;
  };
}

/**
 * Applies keepUnknownEnums() to the responses of every method of a service definition made by
 * proto-loader; `service` is the same service in a protobufjs root.
 */
function keepUnknownEnumsOfService(definition, service) {
  for (let name of Object.keys(definition)) {
    let method = definition[name];
    method.responseDeserialize = keepUnknownEnums(
      method.responseDeserialize,
      service.methods[name].resolvedResponseType
    );
  }
}

module.exports = {
  keepUnknownEnums,
  keepUnknownEnumsOfService,
};
