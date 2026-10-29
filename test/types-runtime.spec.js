// Checks the generated TypeScript declarations against what the runtime really decodes:
// the generator reads the protos with protobufjs 7, the runtime decodes with protobufjs 6
// through @grpc/proto-loader.
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const protobuf = require('protobufjs');
const { loadSync } = require('@grpc/proto-loader');
const { fieldShape, loadLine, renderAll } = require('../util-scripts/generate-types');
const { getLine, supportedVersions } = require('../lib/common');

const LOADER_OPTIONS = { keepCase: true, enums: String, defaults: true, oneofs: true };

function runtimeRoot(line) {
  let root = new protobuf.Root();
  root.resolvePath = (origin, target) =>
    path.isAbsolute(target) ? target : path.join(line.protoDir, target);
  root.loadSync(
    Object.keys(line.api).map(file => path.join(line.protoDir, file)),
    { keepCase: true }
  );
  root.resolveAll();
  return root;
}

function messageTypes(ns, out = []) {
  for (let obj of ns.nestedArray || []) {
    if (obj.fieldsArray) out.push(obj);
    messageTypes(obj, out);
  }
  return out;
}

/** The value `defaults: true` gives a field that is not set, by the kind the types declare. */
function expectDefault(shape, value, longs, field, where) {
  switch (shape.kind) {
    case 'map':
      return expect(value, where).to.deep.equal({});
    case 'repeated':
      return expect(value, where).to.deep.equal([]);
    case 'message':
      return expect(value, where).to.equal(null);
    case 'number':
      return expect(value, where).to.equal(0);
    case 'long':
      return expect(value, where).to.equal(longs === String ? '0' : 0);
    case 'bool':
      return expect(value, where).to.equal(false);
    case 'string':
      return expect(value, where).to.equal('');
    case 'bytes':
      return expect(Buffer.isBuffer(value) && value.length === 0, where).to.equal(true);
    case 'enum':
      return expect(Object.keys(field.resolvedType.values), where).to.include(value);
  }
  throw new Error(`Unknown kind ${shape.kind}`);
}

describe('generated TypeScript declarations', function() {
  this.timeout(60000);

  it('are up to date with the protos (run node util-scripts/generate-types.js)', () => {
    for (let [file, text] of renderAll()) {
      let current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      expect(current === text, path.relative(process.cwd(), file)).to.equal(true);
    }
  });

  for (let lndVersion of supportedVersions) {
    it(`describe the decoded shape of every message of LND ${lndVersion}`, () => {
      let { root: model } = loadLine(lndVersion);
      let runtime = runtimeRoot(getLine(lndVersion));
      let types = messageTypes(model);
      expect(types.length).to.be.greaterThan(300);
      for (let type of types) {
        let runtimeType = runtime.lookupType(type.fullName);
        let present = type.fieldsArray.filter(f => !fieldShape(f).optional);
        for (let longs of [String, Number]) {
          let decoded = runtimeType.toObject(runtimeType.decode(Buffer.alloc(0)), {
            ...LOADER_OPTIONS,
            longs,
          });
          expect(Object.keys(decoded).sort(), type.fullName).to.deep.equal(
            present.map(f => f.name).sort()
          );
          for (let field of present) {
            expectDefault(fieldShape(field), decoded[field.name], longs, field, field.fullName);
          }
        }
      }
    });
  }

  it('match the RPC responses decoded by proto-loader', () => {
    let line = getLine('0.20');
    let { root: model } = loadLine('0.20');
    let checked = 0;
    for (let [file, proto] of Object.entries(line.api)) {
      let definition = loadSync(path.join(line.protoDir, file), {
        ...LOADER_OPTIONS,
        longs: String,
        includeDirs: [line.protoDir],
      });
      for (let serviceName of Object.keys(proto.services)) {
        let service = model.lookupService(`${proto.package}.${serviceName}`);
        for (let method of service.methodsArray) {
          let decoded = definition[`${proto.package}.${serviceName}`][
            method.name
          ].responseDeserialize(Buffer.alloc(0));
          let expected = method.resolvedResponseType.fieldsArray.filter(
            f => !fieldShape(f).optional
          );
          expect(Object.keys(decoded).sort(), method.fullName).to.deep.equal(
            expected.map(f => f.name).sort()
          );
          checked++;
        }
      }
    }
    expect(checked).to.equal(173);
  });

  it('name the member that is set in a oneof', () => {
    let runtime = runtimeRoot(getLine('0.20'));
    let type = runtime.lookupType('lnrpc.OpenStatusUpdate');
    let message = type
      .encode(type.fromObject({ chan_pending: { txid: Buffer.alloc(32, 1), output_index: 1 } }))
      .finish();
    let decoded = type.toObject(type.decode(message), { ...LOADER_OPTIONS, longs: String });
    expect(decoded.update).to.equal('chan_pending');
    expect(decoded.chan_pending.output_index).to.equal(1);
    expect(decoded).to.not.have.property('chan_open');
    expect(decoded).to.not.have.property('psbt_fund');
  });

  it('leave an unset proto3 optional field absent and name a set one', () => {
    let runtime = runtimeRoot(getLine('0.20'));
    let type = runtime.lookupType('invoicesrpc.HtlcModifyResponse');
    let empty = type.toObject(type.decode(Buffer.alloc(0)), { ...LOADER_OPTIONS, longs: String });
    expect(empty).to.not.have.property('amt_paid');
    let set = type.toObject(type.decode(type.encode(type.fromObject({ amt_paid: 5 })).finish()), {
      ...LOADER_OPTIONS,
      longs: String,
    });
    expect(set.amt_paid).to.equal('5');
    expect(set._amt_paid).to.equal('amt_paid');
  });
});
