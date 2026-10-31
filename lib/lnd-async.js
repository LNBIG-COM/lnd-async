const { promisify } = require('util');
const lnrpc = require('./lnd-rpc');
const { defaultVersion, getLine, resolveLndVersion, supportedVersions } = require('./common');
const { ValidationError, getValidators, validate } = require('./strict');

module.exports = {
  connect,
  supportedLndVersions: Object.freeze(supportedVersions.slice()),
  defaultLndVersion: defaultVersion,
  resolveLndVersion,
  validate,
  ValidationError,
};

async function connect(opts = {}) {
  // opts is passed on as is: a copy would lose options defined by getters or a prototype
  let services = await lnrpc.connect(opts);
  let line = getLine(resolveLndVersion(opts.lndVersion));
  let strict = opts.strict;
  return wrapAsync(services, line, strict ? getValidators(line) : null, reporter(strict));
}

/**
 * What strict mode does with an invalid request: null to throw (`strict: true`), or a function
 * that gets the error, after which the request is sent unless the function throws.
 */
function reporter(strict) {
  if (typeof strict === 'function') return strict;
  if (strict === 'warn') return error => process.emitWarning(error);
  return null;
}

function wrapAsync(lnrpc, line, validators, report) {
  let result = {
    lnrpc, // service definition and two services that are now connected
  };
  // The line of the protos, read-only; not enumerable, so code walking the methods skips it
  Object.defineProperty(result, 'lndVersion', { value: line.line });

  // Methods are found by their rpc name (in the order of the grpc-js client, as before) and
  // exposed in lowerCamelCase of it. The lowerCamelCase alias grpc-js adds itself is built by
  // lodash camelCase, which turns DeleteMacaroonID into deleteMacaroonId.
  let addMethods = (target, client, serviceName) => {
    let methods = new Map((line.methods[serviceName] || []).map(m => [m.name, m]));
    for (let name in client) {
      let method = methods.get(name);
      if (method && typeof client[name] === 'function') {
        let validator = validators && validators.get(`${serviceName}.${method.key}`);
        let check = validator && checker(validator, report);
        target[method.key] = method.stream
          ? streamMethod(client, name, check, validator && validator.requestStream)
          : unaryMethod(client, name, check);
      }
    }
  };

  // backward compatibility
  for (let service in lnrpc.services) {
    addMethods(
      result,
      lnrpc.services[service],
      service.charAt(0).toUpperCase() + service.substring(1)
    );
  }

  // All methods, packages and services
  for (let service in lnrpc.allServices) {
    result[service] = {};
    addMethods(result[service], lnrpc.allServices[service], service);
  }
  return result;
}

// A function that throws when a message must not be sent
function checker(validator, report) {
  if (!report) return validator.validate;
  return message => {
    try {
      validator.validate(message);
    } catch (err) {
      report(err);
    }
  };
}

function unaryMethod(client, method, check) {
  let call = promisify(client[method].bind(client));
  if (!check) return call;
  return (request, ...rest) => {
    try {
      check(request);
    } catch (err) {
      return Promise.reject(err);
    }
    return call(request, ...rest);
  };
}

function streamMethod(client, method, check, requestStream) {
  let call = client[method].bind(client);
  if (!check) return call;
  if (requestStream) {
    // Bidirectional: requests are written to the stream, by write() or by end(message)
    return (...args) => {
      let stream = call(...args);
      let { write, end } = stream;
      stream.write = function(message, ...rest) {
        check(message);
        return write.call(this, message, ...rest);
      };
      stream.end = function(message, ...rest) {
        if (message !== undefined && message !== null && typeof message !== 'function') {
          check(message);
        }
        return end.call(this, message, ...rest);
      };
      return stream;
    };
  }
  return (request, ...rest) => {
    check(request);
    return call(request, ...rest);
  };
}
