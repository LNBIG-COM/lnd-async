// Enum values the protos of the line do not have. With `enums: String` protobufjs 6 decodes them
// into undefined (protobufjs 7 keeps the number), so a node newer than the line loses data: the
// CHANNEL_UPDATE event of LND 0.21 came to a client of the 0.20 line as { type: undefined }.
// The response deserializers of proto-loader are wrapped: a response is decoded by proto-loader
// as before, and only when it holds such a value it is decoded again to put the number in place.
const protobuf = require('protobufjs');

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isEnum = field => field.resolvedType instanceof protobuf.Enum;
const isList = field => field.map || field.repeated;

let plansByRoot = new WeakMap();

/**
 * For every message type of `root` that can hold an enum, directly or in a nested message: the
 * fields to look at (its enum fields and its message fields that can hold one).
 * @returns {Map<protobuf.Type, protobuf.Field[]>}
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
    let plans = new Map();
    for (let type of reaching) {
      plans.set(
        type,
        type.fieldsArray.filter(f => isEnum(f) || reaching.has(f.resolvedType))
      );
    }
    plansByRoot.set(root, plans);
  }
  return plansByRoot.get(root);
}

/** Whether `object`, a decoded `type`, holds an enum value decoded into undefined. */
function hasUnknown(plans, type, object) {
  for (let field of plans.get(type)) {
    let value = object[field.name];
    if (isEnum(field)) {
      if (isList(field)) {
        if (value && Object.values(value).includes(undefined)) return true;
      } else if (value === undefined && has(object, field.name)) {
        return true;
      }
    } else if (value) {
      let items = isList(field) ? Object.values(value) : [value];
      if (items.some(item => hasUnknown(plans, field.resolvedType, item))) return true;
    }
  }
  return false;
}

/** Replaces undefined enum values of `object` with the numbers of `message`, the same data. */
function restore(plans, type, object, message) {
  for (let field of plans.get(type)) {
    let value = object[field.name];
    let raw = message[field.name];
    if (isEnum(field)) {
      if (isList(field)) {
        for (let key of Object.keys(value || {})) {
          if (value[key] === undefined) value[key] = raw[key];
        }
      } else if (value === undefined && has(object, field.name)) {
        object[field.name] = raw;
      }
    } else if (value) {
      if (isList(field)) {
        for (let key of Object.keys(value)) {
          restore(plans, field.resolvedType, value[key], raw[key]);
        }
      } else {
        restore(plans, field.resolvedType, value, raw);
      }
    }
  }
}

/**
 * Wraps a deserializer of `type` (from a root with the same protos) so that unknown enum values
 * come out as numbers. Returns `deserialize` itself when the type cannot hold an enum.
 */
function keepUnknownEnums(deserialize, type) {
  let plans = enumPlans(type.root);
  if (!plans.has(type)) return deserialize;
  return function deserializeKeepingUnknownEnums(buffer) {
    let object = deserialize(buffer);
    if (hasUnknown(plans, type, object)) restore(plans, type, object, type.decode(buffer));
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
