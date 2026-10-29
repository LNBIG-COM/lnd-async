const { promisify } = require('util');
const lnrpc = require('./lnd-rpc');
const { defaultVersion, getLine, resolveLndVersion, supportedVersions } = require('./common');
const { ValidationError, getValidators } = require('./strict');

module.exports = {
  connect,
  supportedLndVersions: Object.freeze(supportedVersions.slice()),
  defaultLndVersion: defaultVersion,
  ValidationError,
};

async function connect(opts = {}) {
  let line = getLine(resolveLndVersion(opts.lndVersion));
  let validators = opts.strict ? getValidators(line) : null;
  return wrapAsync(await lnrpc.connect({ ...opts, lndVersion: line.line }), line, validators);
}

function wrapAsync(lnrpc, line, validators) {
  let result = {
    lnrpc, // service definition and two services that are now connected
  };

  // Methods are looked up by their rpc name: the lowerCamelCase alias grpc-js adds is built by
  // lodash camelCase, which turns DeleteMacaroonID into deleteMacaroonId
  let wrap = (client, serviceName, { name, key, stream }) => {
    let validator = validators && validators.get(`${serviceName}.${key}`);
    return stream ? streamMethod(client, name, validator) : unaryMethod(client, name, validator);
  };

  // backward compatibility
  for (let service in lnrpc.services) {
    let serviceName = service.charAt(0).toUpperCase() + service.substring(1);
    for (let method of line.methods[serviceName] || []) {
      if (typeof lnrpc.services[service][method.name] === 'function')
        result[method.key] = wrap(lnrpc.services[service], serviceName, method);
    }
  }

  // All methods, packages and services
  for (let service in lnrpc.allServices) {
    result[service] = {};
    for (let method of line.methods[service] || []) {
      if (typeof lnrpc.allServices[service][method.name] === 'function')
        result[service][method.key] = wrap(lnrpc.allServices[service], service, method);
    }
  }
  return result;
}

function unaryMethod(client, method, validator) {
  let call = promisify(client[method].bind(client));
  if (!validator) return call;
  return (request, ...rest) => {
    try {
      validator.validate(request);
    } catch (err) {
      return Promise.reject(err);
    }
    return call(request, ...rest);
  };
}

function streamMethod(client, method, validator) {
  let call = client[method].bind(client);
  if (!validator) return call;
  if (validator.requestStream) {
    // Bidirectional: requests are written to the stream
    return (...args) => {
      let stream = call(...args);
      let write = stream.write;
      stream.write = function(message, ...rest) {
        validator.validate(message);
        return write.call(this, message, ...rest);
      };
      return stream;
    };
  }
  return (request, ...rest) => {
    validator.validate(request);
    return call(request, ...rest);
  };
}
