// lib/enums.js on a proto of its own: every place an enum value can be in a response.
const { expect } = require('chai');
const protobuf = require('protobufjs');
const { keepUnknownEnums } = require('../lib/enums');

const PROTO = `
syntax = "proto3";
package test;
enum Color { RED = 0; GREEN = 1; }
message Leaf { Color color = 1; repeated Color colors = 2; }
message Tree {
  Color color = 1;
  repeated Color colors = 2;
  map<string, Color> by_name = 3;
  Leaf leaf = 4;
  repeated Leaf leaves = 5;
  map<uint64, Leaf> by_id = 6;
  oneof choice {
    Color chosen = 7;
    Leaf chosen_leaf = 8;
  }
  optional Color maybe = 9;
  Tree child = 10;
}
message Plain { string name = 1; Plain next = 2; }
message Cycle { Back back = 1; }
message Back { Cycle cycle = 1; Color color = 2; }
`;

// What proto-loader does, with the options of lib/lnd-rpc.js
const OPTIONS = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true };
const root = protobuf.parse(PROTO, { keepCase: true }).root;
root.resolveAll();

function deserializer(name) {
  let type = root.lookupType(name);
  return keepUnknownEnums(buffer => type.toObject(type.decode(buffer), OPTIONS), type);
}

// encode() takes the numbers as they are, unlike fromObject(), so values unknown to Color can be sent
const encode = (name, message) =>
  root
    .lookupType(name)
    .encode(message)
    .finish();

describe('enum values the protos do not have', () => {
  it('are decoded into numbers wherever they are', () => {
    let leaf = { color: 5, colors: [1, 6] };
    let tree = {
      color: 2,
      colors: [0, 3, 1],
      by_name: { a: 4, b: 1 },
      leaf,
      leaves: [{ color: 1 }, leaf],
      by_id: { 7: leaf },
      chosen: 8,
      maybe: 9,
      child: { color: 10, chosen_leaf: { colors: [11] } },
    };
    let decoded = deserializer('test.Tree')(encode('test.Tree', tree));
    expect(decoded.color).to.equal(2);
    expect(decoded.colors).to.deep.equal(['RED', 3, 'GREEN']);
    expect(decoded.by_name).to.deep.equal({ a: 4, b: 'GREEN' });
    expect(decoded.leaf).to.deep.equal({ color: 5, colors: ['GREEN', 6] });
    expect(decoded.leaves).to.deep.equal([
      { color: 'GREEN', colors: [] },
      { color: 5, colors: ['GREEN', 6] },
    ]);
    expect(Object.values(decoded.by_id)).to.deep.equal([{ color: 5, colors: ['GREEN', 6] }]);
    expect(decoded.chosen).to.equal(8);
    expect(decoded.choice).to.equal('chosen');
    expect(decoded.maybe).to.equal(9);
    expect(decoded._maybe).to.equal('maybe');
    expect(decoded.child.color).to.equal(10);
    expect(decoded.child.chosen_leaf.colors).to.deep.equal([11]);
    expect(decoded).to.not.have.property('chosen_leaf');
  });

  it('do not change a response without them', () => {
    let tree = { color: 1, leaves: [{ color: 1 }], maybe: 0, child: { chosen: 1 } };
    let wire = encode('test.Tree', tree);
    let type = root.lookupType('test.Tree');
    let decoded = deserializer('test.Tree')(wire);
    expect(decoded).to.deep.equal(type.toObject(type.decode(wire), OPTIONS));
    expect(decoded).to.not.have.property('chosen');
    expect(decoded.child.chosen).to.equal('GREEN');
  });

  it('are looked for in messages that refer to each other', () => {
    let decoded = deserializer('test.Cycle')(
      encode('test.Cycle', { back: { color: 1, cycle: { back: { color: 4 } } } })
    );
    expect(decoded.back.color).to.equal('GREEN');
    expect(decoded.back.cycle.back.color).to.equal(4);
  });

  it('leave the deserializer of a message without enums as it is', () => {
    let deserialize = () => ({});
    expect(keepUnknownEnums(deserialize, root.lookupType('test.Plain'))).to.equal(deserialize);
    expect(keepUnknownEnums(deserialize, root.lookupType('test.Leaf'))).to.not.equal(deserialize);
  });
});
