// Tests that run without a real LND node: a local gRPC server plays LND.
const { expect } = require('chai');
const sinon = require('sinon');
const sut = require('../lib/lnd-async');
const { createCertificate, startMockLnd } = require('./helpers/mock-lnd');
const { getLine } = require('../lib/common');

const MACAROON = Buffer.from('macaroon bytes');

describe('lnd-async against a mock LND', function() {
  this.timeout(10000);
  let certificate;
  let clients = [];

  before(function() {
    try {
      certificate = createCertificate();
    } catch (err) {
      this.skip(); // no openssl
    }
  });

  after(() => {
    for (let client of clients)
      for (let raw of Object.values(client.lnrpc.allServices)) raw.close();
  });

  async function connect(mock, options = {}) {
    let client = await sut.connect({
      lndHost: '127.0.0.1',
      lndPort: mock.port,
      cert: certificate.cert.toString('base64'),
      macaroon: MACAROON.toString('base64'),
      ...options,
    });
    clients.push(client);
    return client;
  }

  describe('default line', () => {
    let mock;
    let interceptorRequests = [];

    before(async () => {
      mock = await startMockLnd({
        certificate,
        handlers: {
          Lightning: {
            GetInfo: (call, callback) =>
              callback(null, {
                alias: 'mock',
                block_height: 800000,
                best_header_timestamp: '1700000000',
                chains: [{ chain: 'bitcoin', network: 'regtest' }],
              }),
            AddInvoice: (call, callback) =>
              callback(null, {
                r_hash: Buffer.alloc(32, 1),
                payment_request: 'lnbcrt1',
                add_index: '7',
              }),
            SubscribeInvoices: call => {
              call.write({
                memo: 'first',
                value: '1000',
                r_hash: Buffer.alloc(32, 2),
                state: 'SETTLED',
              });
              call.write({ memo: 'second', value_msat: '9007199254740993' });
              call.end();
            },
          },
          Router: {
            HtlcInterceptor: call => {
              call.on('data', response => {
                interceptorRequests.push(response);
                call.write({
                  incoming_circuit_key: { chan_id: '1', htlc_id: '2' },
                  outgoing_amount_msat: '1000',
                });
              });
              call.on('end', () => call.end());
            },
          },
        },
      });
    });

    after(() => mock.close());

    it('sends the macaroon as hex metadata', async () => {
      let client = await connect(mock);
      await client.getInfo({});
      let call = mock.calls.find(c => c.method === 'Lightning.GetInfo');
      expect(call.metadata.get('macaroon')).to.deep.equal([MACAROON.toString('hex')]);
    });

    it('reads options through getters and the prototype chain, as before', async () => {
      class Options {
        get lndHost() {
          return '127.0.0.1';
        }
        get lndPort() {
          return mock.port;
        }
        get cert() {
          return certificate.cert.toString('base64');
        }
      }
      let options = Object.create(new Options());
      Object.defineProperty(options, 'macaroon', { value: MACAROON.toString('base64') });
      let client = await sut.connect(options);
      clients.push(client);
      expect((await client.getInfo({})).alias).to.equal('mock');
      let call = mock.calls.filter(c => c.method === 'Lightning.GetInfo').pop();
      expect(call.metadata.get('macaroon')).to.deep.equal([MACAROON.toString('hex')]);
    });

    it('decodes responses with defaults, string longs and snake_case names', async () => {
      let client = await connect(mock);
      let info = await client.getInfo({});
      expect(info.alias).to.equal('mock');
      expect(info.block_height).to.equal(800000);
      expect(info.best_header_timestamp).to.equal('1700000000');
      expect(info.testnet).to.equal(false);
      expect(info.uris).to.deep.equal([]);
      expect(info.features).to.deep.equal({});
      expect(info.chains).to.deep.equal([{ chain: 'bitcoin', network: 'regtest' }]);
      expect(info).to.not.have.property('blockHeight');
      expect(await client.Lightning.getInfo({})).to.deep.equal(info);
    });

    it('returns longs as numbers with longsAsNumbers', async () => {
      let client = await connect(mock, { longsAsNumbers: true });
      let info = await client.getInfo({});
      expect(info.best_header_timestamp).to.equal(1700000000);
    });

    it('streams server responses', async () => {
      let client = await connect(mock);
      let invoices = [];
      await new Promise((resolve, reject) =>
        client
          .subscribeInvoices({})
          .on('data', invoice => invoices.push(invoice))
          .on('error', reject)
          .on('end', resolve)
      );
      expect(invoices.map(i => i.memo)).to.deep.equal(['first', 'second']);
      expect(Buffer.isBuffer(invoices[0].r_hash)).to.equal(true);
      expect(invoices[0].state).to.equal('SETTLED');
      expect(invoices[0].value).to.equal('1000');
      expect(invoices[1].value_msat).to.equal('9007199254740993');
      expect(invoices[1].state).to.equal('OPEN');
    });

    it('streams in both directions', async () => {
      let client = await connect(mock);
      let interceptor = client.Router.htlcInterceptor();
      let received = new Promise(resolve => interceptor.once('data', resolve));
      interceptor.write({ incoming_circuit_key: { chan_id: '5', htlc_id: '6' }, action: 'RESUME' });
      let request = await received;
      interceptor.end();
      expect(request.incoming_circuit_key).to.deep.equal({ chan_id: '1', htlc_id: '2' });
      expect(request.outgoing_amount_msat).to.equal('1000');
      expect(interceptorRequests[0].action).to.equal('RESUME');
      expect(interceptorRequests[0].incoming_circuit_key).to.deep.equal({
        chan_id: '5',
        htlc_id: '6',
      });
    });

    describe('without strict mode (protobufjs behaviour, unchanged)', () => {
      it('silently drops unknown fields', async () => {
        let client = await connect(mock);
        await client.addInvoice({ valeu: 1000, memo: 'typo' });
        let call = mock.calls.filter(c => c.method === 'Lightning.AddInvoice').pop();
        expect(call.request.memo).to.equal('typo');
        expect(call.request.value).to.equal('0');
      });

      it('turns an unknown enum name into the first value of the enum', async () => {
        let client = await connect(mock);
        let interceptor = client.Router.htlcInterceptor();
        let received = new Promise(resolve => interceptor.once('data', resolve));
        interceptor.write({
          incoming_circuit_key: { chan_id: '1', htlc_id: '1' },
          action: 'ACCEPT',
        });
        await received;
        interceptor.end();
        // ResolveHoldForwardAction: SETTLE = 0
        expect(interceptorRequests.pop().action).to.equal('SETTLE');
      });
    });

    describe('strict mode', () => {
      it('rejects an unknown field before sending anything', async () => {
        let client = await connect(mock, { strict: true });
        let before = mock.calls.length;
        let err = await client.addInvoice({ valeu: 1000 }).then(
          () => null,
          e => e
        );
        expect(err).to.be.instanceOf(sut.ValidationError);
        expect(err).to.be.instanceOf(TypeError);
        expect(err.messageType).to.equal('lnrpc.Invoice');
        expect(err.path).to.equal('valeu');
        expect(err.method).to.equal('Lightning.addInvoice');
        expect(err.message).to.equal('lnrpc.Invoice.valeu: unknown field (did you mean "value"?)');
        expect(mock.calls.length).to.equal(before);
      });

      it('suggests the snake_case name for a camelCase field', async () => {
        let client = await connect(mock, { strict: true });
        let err = await client.Lightning.addInvoice({ rPreimage: Buffer.alloc(32) }).then(
          () => null,
          e => e
        );
        expect(err.message).to.contain('did you mean "r_preimage"?');
      });

      it('sends valid requests unchanged', async () => {
        let client = await connect(mock, { strict: true });
        let response = await client.addInvoice({
          value: 1000,
          memo: 'ok',
          r_preimage: Buffer.alloc(32, 3),
        });
        expect(response.add_index).to.equal('7');
        let call = mock.calls.filter(c => c.method === 'Lightning.AddInvoice').pop();
        expect(call.request.value).to.equal('1000');
        expect(call.request.r_preimage).to.deep.equal(Buffer.alloc(32, 3));
      });

      it('throws on a server-streaming request synchronously', async () => {
        let client = await connect(mock, { strict: true });
        expect(() => client.subscribeInvoices({ add_index: -1 })).to.throw(
          sut.ValidationError,
          'lnrpc.InvoiceSubscription.add_index: expected an integer from 0 to 18446744073709551615 (uint64)'
        );
      });

      it('validates every message written to a bidirectional stream', async () => {
        let client = await connect(mock, { strict: true });
        let interceptor = client.Router.htlcInterceptor();
        expect(() => interceptor.write({ action: 'ACCEPT' })).to.throw(
          sut.ValidationError,
          'routerrpc.ForwardHtlcInterceptResponse.action: expected a value of routerrpc.ResolveHoldForwardAction'
        );
        let received = new Promise(resolve => interceptor.once('data', resolve));
        interceptor.write({ incoming_circuit_key: { chan_id: '9', htlc_id: '9' }, action: 'FAIL' });
        await received;
        interceptor.end();
        expect(interceptorRequests.pop().action).to.equal('FAIL');
      });

      it('validates a message passed to end() of a bidirectional stream', async () => {
        let client = await connect(mock, { strict: true });
        let interceptor = client.Router.htlcInterceptor();
        interceptor.on('error', () => {}); // CANCELLED by the cancel() below
        expect(() => interceptor.end({ action: 'ACCEPT' })).to.throw(
          sut.ValidationError,
          'routerrpc.ForwardHtlcInterceptResponse.action: expected a value of'
        );
        interceptor.cancel();
      });

      it('sends an invalid request when a function gets the error', async () => {
        let errors = [];
        let client = await connect(mock, { strict: error => errors.push(error) });
        let response = await client.addInvoice({ valeu: 1000, memo: 'reported' });
        expect(response.add_index).to.equal('7');
        expect(
          mock.calls.filter(c => c.method === 'Lightning.AddInvoice').pop().request.memo
        ).to.equal('reported');
        await client.Lightning.addInvoice({ value: 1000 });
        expect(errors).to.have.length(1);
        expect(errors[0]).to.be.instanceOf(sut.ValidationError);
        expect(errors[0].method).to.equal('Lightning.addInvoice');
        expect(errors[0].path).to.equal('valeu');

        let interceptor = client.Router.htlcInterceptor();
        let received = new Promise(resolve => interceptor.once('data', resolve));
        interceptor.write({
          incoming_circuit_key: { chan_id: '3', htlc_id: '3' },
          action: 'ACCEPT',
        });
        await received;
        interceptor.end();
        expect(interceptorRequests.pop().action).to.equal('SETTLE'); // as without strict
        expect(errors[1].method).to.equal('Router.htlcInterceptor');
        expect(errors[1].path).to.equal('action');
      });

      it('does not send a request when the function throws', async () => {
        let client = await connect(mock, {
          strict: error => {
            throw error;
          },
        });
        let before = mock.calls.length;
        let err = await client.addInvoice({ valeu: 1000 }).then(
          () => null,
          e => e
        );
        expect(err).to.be.instanceOf(sut.ValidationError);
        expect(() => client.subscribeInvoices({ add_index: -1 })).to.throw(sut.ValidationError);
        expect(mock.calls.length).to.equal(before);
      });

      it("emits a process warning and sends the request with strict: 'warn'", async () => {
        let warnings = [];
        // Other warnings (DEP0123 of the first TLS connection to an IP address) pass through
        let emitWarning = sinon
          .stub(process, 'emitWarning')
          .callsFake((warning, ...rest) =>
            warning instanceof sut.ValidationError
              ? warnings.push(warning)
              : emitWarning.wrappedMethod.call(process, warning, ...rest)
          );
        try {
          let client = await connect(mock, { strict: 'warn' });
          await client.addInvoice({ valeu: 1000, memo: 'warned' });
          await new Promise((resolve, reject) =>
            client
              .subscribeInvoices({ add_index: -1 })
              .on('data', () => {})
              .on('error', reject)
              .on('end', resolve)
          );
        } finally {
          emitWarning.restore();
        }
        expect(
          mock.calls.filter(c => c.method === 'Lightning.AddInvoice').pop().request.memo
        ).to.equal('warned');
        expect(mock.calls.pop().method).to.equal('Lightning.SubscribeInvoices');
        expect(warnings.map(w => w instanceof sut.ValidationError)).to.deep.equal([true, true]);
        expect(warnings.map(w => w.method)).to.deep.equal([
          'Lightning.addInvoice',
          'Lightning.subscribeInvoices',
        ]);
      });

      it('rejects a missing request', async () => {
        let client = await connect(mock, { strict: true });
        let err = await client.getInfo().then(
          () => null,
          e => e
        );
        expect(err.message).to.equal(
          'lnrpc.GetInfoRequest: expected an object, got undefined undefined'
        );
      });
    });
  });

  describe('lndVersion', () => {
    it('talks to a 0.21 server with the 0.21 protos', async () => {
      let mock = await startMockLnd({
        certificate,
        lndVersion: '0.21',
        handlers: { Lightning: { SendOnionMessage: (call, callback) => callback(null, {}) } },
      });
      try {
        let client = await connect(mock, { lndVersion: '0.21' });
        await client.sendOnionMessage({ peer: Buffer.alloc(33, 2), onion: Buffer.from('onion') });
        let call = mock.calls.pop();
        expect(call.method).to.equal('Lightning.SendOnionMessage');
        expect(call.request.onion.toString()).to.equal('onion');
        expect(client.sendPaymentSync).to.equal(undefined);
      } finally {
        await mock.close();
      }
    });

    describe('enum values of a newer LND', () => {
      let mock;

      before(async () => {
        mock = await startMockLnd({
          certificate,
          lndVersion: '0.21',
          handlers: {
            Lightning: {
              SubscribeChannelEvents: call => {
                call.write({
                  type: 'CHANNEL_UPDATE',
                  updated_channel: { channel: { chan_id: '1' } },
                });
                call.write({ type: 'ACTIVE_CHANNEL', active_channel: { funding_txid_str: 'ab' } });
                call.end();
              },
              // TAPROOT = 7 is new in 0.21; it is only in the elements of a list
              ListChannels: (call, callback) =>
                callback(null, {
                  channels: [
                    { chan_id: '1', commitment_type: 'ANCHORS' },
                    { chan_id: '2', commitment_type: 'TAPROOT' },
                  ],
                }),
              ChannelAcceptor: call => {
                call.write({ pending_chan_id: Buffer.alloc(32), commitment_type: 'TAPROOT' });
                call.on('data', () => call.end());
              },
            },
          },
        });
      });

      after(() => mock.close());

      it('come as numbers from a server stream', async () => {
        let client = await connect(mock, { lndVersion: '0.20' });
        let events = [];
        await new Promise((resolve, reject) =>
          client
            .subscribeChannelEvents({})
            .on('data', event => events.push(event))
            .on('error', reject)
            .on('end', resolve)
        );
        // updated_channel is a field the 0.20 protos do not have, so it is dropped
        expect(events[0]).to.deep.equal({ type: 7 });
        expect(events[1].type).to.equal('ACTIVE_CHANNEL');
        expect(events[1].active_channel.funding_txid_str).to.equal('ab');
      });

      it('come as numbers from a unary call, with either longs', async () => {
        let client = await connect(mock, { lndVersion: '0.20' });
        let { channels } = await client.listChannels({});
        expect(channels.map(c => [c.chan_id, c.commitment_type])).to.deep.equal([
          ['1', 'ANCHORS'],
          ['2', 7],
        ]);
        let numbers = await connect(mock, { lndVersion: '0.20', longsAsNumbers: true });
        channels = (await numbers.Lightning.listChannels({})).channels;
        expect(channels.map(c => [c.chan_id, c.commitment_type])).to.deep.equal([
          [1, 'ANCHORS'],
          [2, 7],
        ]);
      });

      it('come as numbers from a bidirectional stream', async () => {
        let client = await connect(mock, { lndVersion: '0.20' });
        let acceptor = client.channelAcceptor();
        let request = await new Promise((resolve, reject) =>
          acceptor.once('data', resolve).once('error', reject)
        );
        acceptor.write({ pending_chan_id: request.pending_chan_id, accept: false });
        await new Promise(resolve => acceptor.on('end', resolve).resume());
        expect(request.commitment_type).to.equal(7);
      });
    });
  });
});

describe('lnd-async client surface', () => {
  let base = { lndHost: '127.0.0.1', lndPort: 1, noCert: true, noMacaroons: true };

  it('exposes the bundled LND lines', () => {
    expect(sut.supportedLndVersions).to.deep.equal(['0.18', '0.19', '0.20', '0.21']);
    expect(sut.defaultLndVersion).to.equal('0.20');
  });

  it('keeps the default surface: flat Lightning/WalletUnlocker/State methods and all services', async () => {
    let client = await sut.connect(base);
    let services = Object.keys(client).filter(k => /^[A-Z]/.test(k));
    let flat = Object.keys(client).filter(k => /^[a-z]/.test(k) && k !== 'lnrpc');
    expect(services).to.have.length(16);
    expect(flat).to.have.length(75);
    expect(services.reduce((n, s) => n + Object.keys(client[s]).length, 0)).to.equal(173);
    for (let name of flat) expect(client[name]).to.be.a('function');
    expect(client.lnrpc.services).to.have.keys('lightning', 'walletUnlocker', 'state');
  });

  it('exposes rpcs with consecutive capitals under the lowerCamelCase of the rpc name', async () => {
    let client = await sut.connect(base);
    expect(client.deleteMacaroonID).to.be.a('function');
    expect(client.registerRPCMiddleware).to.be.a('function');
    expect(client.Lightning.deleteMacaroonID).to.be.a('function');
    expect(client.Lightning.listMacaroonIDs).to.be.a('function');
    expect(client.Router.xImportMissionControl).to.be.a('function');
    expect(client.Signer.muSig2CreateSession).to.be.a('function');
    expect(client).to.not.have.property('deleteMacaroonId');
  });

  it('has the methods the TypeScript declarations promise, in every line', async () => {
    let { loadLine } = require('../util-scripts/generate-types');
    for (let lndVersion of sut.supportedLndVersions) {
      let { root } = loadLine(lndVersion);
      let declared = [];
      (function visit(ns) {
        for (let obj of ns.nestedArray || []) {
          if (obj.methodsArray) {
            for (let m of obj.methodsArray)
              declared.push(`${obj.name}.${m.name[0].toLowerCase()}${m.name.slice(1)}`);
          }
          visit(obj);
        }
      })(root);
      let client = await sut.connect({ ...base, lndVersion });
      let actual = [];
      for (let service of Object.keys(client).filter(k => /^[A-Z]/.test(k))) {
        for (let method of Object.keys(client[service])) actual.push(`${service}.${method}`);
      }
      expect(actual.sort(), lndVersion).to.deep.equal(declared.sort());
    }
  });

  it('matches all-api.js of every line', async () => {
    for (let lndVersion of sut.supportedLndVersions) {
      let line = getLine(lndVersion);
      let client = await sut.connect({ ...base, lndVersion });
      let methods = new Set();
      for (let service of Object.keys(client).filter(k => /^[A-Z]/.test(k))) {
        for (let method of Object.keys(client[service])) methods.add(`${service}.${method}`);
      }
      expect([...methods].sort()).to.deep.equal(
        [...line.allStreamApi, ...line.allCallbackApi].sort()
      );
    }
  });

  it('selects the line from a full version string', async () => {
    let client = await sut.connect({ ...base, lndVersion: '0.21.5-beta commit=v0.21.5-beta' });
    expect(client.sendOnionMessage).to.be.a('function');
    expect(client.sendPaymentSync).to.equal(undefined);
    let old = await sut.connect({ ...base, lndVersion: 'v0.18.5-beta' });
    expect(old.Lightning.deleteCanceledInvoice).to.equal(undefined);
  });

  describe('enum values the line does not have', () => {
    // The method definition the client decodes responses with
    let method = async (lndVersion, service, rpc) => {
      let client = await sut.connect({ ...base, lndVersion });
      return client.lnrpc.allServices[service].constructor.service[rpc];
    };

    it('are decoded into numbers, known values stay names', async () => {
      let newer = await method('0.21', 'Lightning', 'SubscribeChannelEvents');
      let older = await method('0.20', 'Lightning', 'SubscribeChannelEvents');
      let wire = newer.responseSerialize({
        type: 'CHANNEL_UPDATE',
        updated_channel: { channel: { chan_id: '123', active: true } },
      });
      expect(newer.responseDeserialize(wire).type).to.equal('CHANNEL_UPDATE');
      expect(older.responseDeserialize(wire)).to.deep.equal({ type: 7 });
      let known = older.responseDeserialize(
        newer.responseSerialize({ type: 'CLOSED_CHANNEL', closed_channel: { chan_id: '5' } })
      );
      expect(known.type).to.equal('CLOSED_CHANNEL');
      expect(known.channel).to.equal('closed_channel');
      expect(known.closed_channel.chan_id).to.equal('5');
    });

    it('are decoded into numbers deep in a list of a unary response', async () => {
      // encode() of protobufjs writes the numbers as they are, values the protos do not have too
      let { getRoot } = require('../lib/common');
      let root = getRoot(getLine('0.20'));
      let encode = (type, message) =>
        root
          .lookupType(type)
          .encode(message)
          .finish();
      let channels = (await method('0.20', 'Lightning', 'ListChannels')).responseDeserialize(
        encode('lnrpc.ListChannelsResponse', {
          channels: [
            { chan_id: 1, commitment_type: 3 },
            { chan_id: 2, commitment_type: 99 },
          ],
        })
      ).channels;
      expect(channels.map(c => c.commitment_type)).to.deep.equal(['ANCHORS', 99]);
      let payments = (await method('0.20', 'Lightning', 'ListPayments')).responseDeserialize(
        encode('lnrpc.ListPaymentsResponse', {
          payments: [
            { payment_index: 1, status: 2 },
            { payment_index: 2, status: 2, htlcs: [{ attempt_id: 1, failure: { code: 77 } }] },
          ],
        })
      ).payments;
      expect(payments.map(p => p.status)).to.deep.equal(['SUCCEEDED', 'SUCCEEDED']);
      expect(payments[1].htlcs[0].failure.code).to.equal(77);
      expect(payments[1].htlcs[0].status).to.equal('IN_FLIGHT');
    });

    it('are decoded into numbers in nested messages and with longsAsNumbers', async () => {
      let newer = await method('0.21', 'Router', 'SubscribeHtlcEvents');
      let wire = newer.responseSerialize({
        incoming_channel_id: '9',
        event_type: 'FORWARD',
        link_fail_event: {
          info: { incoming_amt_msat: '1000' },
          wire_failure: 'TEMPORARY_CHANNEL_FAILURE',
          failure_detail: 'INVOICE_ALREADY_SETTLED',
        },
      });
      let event = (await method('0.18', 'Router', 'SubscribeHtlcEvents')).responseDeserialize(wire);
      expect(event.event_type).to.equal('FORWARD');
      expect(event.incoming_channel_id).to.equal('9');
      expect(event.link_fail_event.wire_failure).to.equal('TEMPORARY_CHANNEL_FAILURE');
      expect(event.link_fail_event.failure_detail).to.equal(23);
      let client = await sut.connect({ ...base, lndVersion: '0.18', longsAsNumbers: true });
      let numbers = client.lnrpc.allServices.Router.constructor.service.SubscribeHtlcEvents;
      let decoded = numbers.responseDeserialize(wire);
      expect(decoded.incoming_channel_id).to.equal(9);
      expect(decoded.link_fail_event.failure_detail).to.equal(23);
    });
  });

  it('tells the line it was made with', async () => {
    let client = await sut.connect({ ...base, lndVersion: '0.21.5-beta' });
    expect(client.lndVersion).to.equal('0.21');
    expect((await sut.connect(base)).lndVersion).to.equal('0.20');
    // Not among the methods, and read-only
    expect(Object.keys(client)).to.not.include('lndVersion');
    expect(() => {
      'use strict';
      client.lndVersion = '0.18';
    }).to.throw(TypeError);
    expect(client.lndVersion).to.equal('0.21');
  });

  it('maps a version string to its line without connecting', () => {
    expect(sut.resolveLndVersion('0.21.5-beta commit=v0.21.5-beta')).to.equal('0.21');
    expect(sut.resolveLndVersion('v0.18.5-beta')).to.equal('0.18');
    expect(sut.resolveLndVersion('0.19')).to.equal('0.19');
    expect(sut.resolveLndVersion()).to.equal('0.20');
    expect(() => sut.resolveLndVersion('0.22.0-beta')).to.throw(
      'Unsupported lndVersion "0.22.0-beta"; the supported LND lines are 0.18, 0.19, 0.20, 0.21'
    );
  });

  it('gives the directory of the protos of a line', () => {
    let fs = require('fs');
    let path = require('path');
    let lightning = lndVersion =>
      fs.readFileSync(path.join(sut.protoDir(lndVersion), 'lightning.proto'), 'utf8');
    expect(path.isAbsolute(sut.protoDir('0.21'))).to.equal(true);
    expect(lightning('0.21.5-beta')).to.contain('rpc SendOnionMessage');
    expect(lightning('0.20')).to.not.contain('rpc SendOnionMessage');
    expect(sut.protoDir()).to.equal(sut.protoDir('0.20'));
    for (let lndVersion of sut.supportedLndVersions) {
      expect(fs.existsSync(path.join(sut.protoDir(lndVersion), 'routerrpc/router.proto'))).to.equal(
        true
      );
    }
    expect(() => sut.protoDir('0.17')).to.throw('Unsupported lndVersion "0.17"');
  });

  it('leaves a method the line does not have undefined, for typeof checks', async () => {
    let flat = lndVersion => {
      let line = getLine(lndVersion);
      return new Set([...line.streamApis, ...line.callbackApis]);
    };
    let everyLine = new Set(sut.supportedLndVersions.flatMap(v => [...flat(v)]));
    for (let lndVersion of sut.supportedLndVersions) {
      let client = await sut.connect({ ...base, lndVersion });
      let has = flat(lndVersion);
      for (let name of everyLine) {
        expect(typeof client[name], `${lndVersion} ${name}`).to.equal(
          has.has(name) ? 'function' : 'undefined'
        );
      }
    }
    let client = await sut.connect({ ...base, lndVersion: '0.21' });
    expect(() => client.sendPaymentSync({})).to.throw(TypeError, 'is not a function');
  });

  it('names the member of a proto3 optional field that is set', async () => {
    let client = await sut.connect({ ...base, lndVersion: '0.21' });
    let {
      responseSerialize,
      responseDeserialize,
    } = client.lnrpc.allServices.Lightning.constructor.service.ForwardingHistory;
    let response = responseDeserialize(
      responseSerialize({
        forwarding_events: [{ chan_id_in: '1', incoming_htlc_id: '5' }, { chan_id_in: '2' }],
      })
    );
    let [set, unset] = response.forwarding_events;
    expect(set.incoming_htlc_id).to.equal('5');
    expect(set._incoming_htlc_id).to.equal('incoming_htlc_id');
    expect(set).to.not.have.property('outgoing_htlc_id');
    expect(set).to.not.have.property('_outgoing_htlc_id');
    expect(unset).to.not.have.property('incoming_htlc_id');
    expect(unset).to.not.have.property('_incoming_htlc_id');
    expect(JSON.parse(JSON.stringify(set))).to.include({ _incoming_htlc_id: 'incoming_htlc_id' });
  });

  it('rejects an unsupported value of strict', async () => {
    for (let strict of ['warning', 'Warn', 'true', 'false', 1, {}]) {
      let err = await sut.connect({ ...base, strict }).then(
        () => null,
        e => e
      );
      expect(err, String(strict)).to.be.instanceOf(TypeError);
      expect(err.message).to.match(
        /^Unsupported strict option .*; use true, false, 'warn' or a function$/
      );
    }
    for (let strict of [undefined, null, false, true, 'warn', () => {}]) {
      await sut.connect({ ...base, strict });
    }
  });

  it('rejects an unsupported lndVersion', async () => {
    let err = await sut.connect({ ...base, lndVersion: '0.17' }).then(
      () => null,
      e => e
    );
    expect(err.message).to.equal(
      'Unsupported lndVersion "0.17"; the supported LND lines are 0.18, 0.19, 0.20, 0.21'
    );
  });
});

describe('strict mode validation', () => {
  let { getValidators } = require('../lib/strict');
  let validators = getValidators(getLine('0.20'));
  let sendPayment = request => validators.get('Router.sendPaymentV2').validate(request);
  let updatePolicy = request => validators.get('Lightning.updateChannelPolicy').validate(request);
  let rejects = (fn, message) => expect(fn).to.throw(sut.ValidationError, message);

  it('accepts a valid request with every kind of field', () => {
    sendPayment({
      dest: Buffer.alloc(33, 2),
      amt: 1000,
      amt_msat: '1000000',
      payment_hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      final_cltv_delta: 40,
      fee_limit_msat: { low: 1000, high: 0 },
      outgoing_chan_ids: ['1', 2],
      dest_custom_records: { 65536: Buffer.from('a'), '65537': 'YQ==' },
      route_hints: [{ hop_hints: [{ chan_id: '1', fee_base_msat: 1, cltv_expiry_delta: 40 }] }],
      dest_features: ['MPP_OPT', 9],
      max_parts: 16,
      time_pref: 0.5,
      no_inflight_updates: true,
      payment_request: undefined,
      cltv_limit: null,
    });
  });

  it('checks integer ranges and 64-bit values', () => {
    rejects(
      () => sendPayment({ final_cltv_delta: 2 ** 31 }),
      'final_cltv_delta: expected an integer from -2147483648'
    );
    rejects(
      () => sendPayment({ max_parts: -1 }),
      'max_parts: expected an integer from 0 to 4294967295 (uint32)'
    );
    rejects(() => sendPayment({ max_parts: 1.5 }), 'max_parts: expected an integer');
    rejects(() => sendPayment({ amt: 2 ** 53 }), 'beyond 2^53, pass it as a string');
    rejects(
      () => sendPayment({ amt: '9223372036854775808' }),
      'amt: expected an integer from -9223372036854775808'
    );
    rejects(() => sendPayment({ amt: 10n }), 'got the bigint 10');
    rejects(() => sendPayment({ amt: '1e3' }), 'got the string "1e3"');
    rejects(
      () => sendPayment({ outgoing_chan_ids: ['-1'] }),
      'outgoing_chan_ids[0]: expected an integer from 0'
    );
  });

  it('accepts decimal strings in 32-bit integer fields, which protobufjs encodes exactly', async () => {
    updatePolicy({
      global: true,
      fee_rate_ppm: '2059',
      base_fee_msat: '1000',
      min_htlc_msat: '1000',
      time_lock_delta: '40',
    });
    sendPayment({ final_cltv_delta: '-2147483648', max_parts: '4294967295', cltv_limit: '007' });
    let client = await sut.connect({ lndPort: 1, noCert: true, noMacaroons: true });
    let service = client.lnrpc.allServices.Lightning.constructor.service;
    let { requestSerialize } = service.UpdateChannelPolicy;
    expect(
      requestSerialize({ global: true, fee_rate_ppm: '2059', time_lock_delta: '40' })
    ).to.deep.equal(requestSerialize({ global: true, fee_rate_ppm: 2059, time_lock_delta: 40 }));
    let expected =
      'expected an integer from 0 to 4294967295 (uint32) as a number or a decimal string';
    rejects(
      () => updatePolicy({ fee_rate_ppm: '4294967296' }),
      `fee_rate_ppm: ${expected}, got the string "4294967296"`
    );
    rejects(() => updatePolicy({ fee_rate_ppm: '-1' }), `fee_rate_ppm: ${expected}`);
    for (let bad of ['1e3', '0x10', ' 40', '40.0', '', '+40', '1'.repeat(400)]) {
      rejects(() => updatePolicy({ time_lock_delta: bad }), `time_lock_delta: ${expected}`);
    }
    let {
      requestSerialize: sendPaymentV2,
    } = client.lnrpc.allServices.Router.constructor.service.SendPaymentV2;
    expect(sendPaymentV2({ final_cltv_delta: '-2147483648', max_parts: '007' })).to.deep.equal(
      sendPaymentV2({ final_cltv_delta: -2147483648, max_parts: 7 })
    );
    // What protobufjs would send instead
    expect(requestSerialize({ fee_rate_ppm: '4294967296' })).to.deep.equal(
      requestSerialize({ fee_rate_ppm: 0 })
    );
    rejects(
      () => sendPayment({ final_cltv_delta: '2147483648' }),
      'final_cltv_delta: expected an integer from -2147483648 to 2147483647 (int32) as a number or a decimal string'
    );
  });

  it('checks strings, booleans, doubles and bytes', () => {
    rejects(
      () => sendPayment({ payment_request: 42 }),
      'payment_request: expected a string, got number 42'
    );
    rejects(
      () => sendPayment({ no_inflight_updates: 'yes' }),
      'expected a boolean, got the string "yes"'
    );
    rejects(() => sendPayment({ time_pref: '0.5' }), 'time_pref: expected a number');
    rejects(
      () => sendPayment({ dest: 'not base64!' }),
      'dest: expected a Buffer, a Uint8Array or a base64 string'
    );
    rejects(
      () => sendPayment({ dest: [1, 2] }),
      'dest: expected a Buffer, a Uint8Array or a base64 string, got an array'
    );
  });

  it('checks repeated fields, maps and nested messages with their path', () => {
    rejects(() => sendPayment({ outgoing_chan_ids: '1' }), 'outgoing_chan_ids: expected an array');
    rejects(() => sendPayment({ outgoing_chan_ids: [null] }), 'outgoing_chan_ids[0]: expected');
    rejects(
      () => sendPayment({ dest_custom_records: { abc: 'YQ==' } }),
      'dest_custom_records["abc"]: expected an integer map key (uint64)'
    );
    rejects(
      () => sendPayment({ dest_custom_records: { 1: 5 } }),
      'dest_custom_records["1"]: expected a Buffer'
    );
    rejects(
      () => sendPayment({ route_hints: [{ hop_hints: [{ chan_id: '1', fee_base_msat: -1 }] }] }),
      'routerrpc.SendPaymentRequest.route_hints[0].hop_hints[0].fee_base_msat: expected an integer from 0'
    );
    rejects(
      () => sendPayment({ route_hints: [{ hop_hint: [] }] }),
      'route_hints[0].hop_hint: unknown field (did you mean "hop_hints"?)'
    );
    rejects(
      () => sendPayment({ route_hints: ['x'] }),
      'route_hints[0]: expected an object, got the string "x"'
    );
  });

  it('checks enum values by name and number', () => {
    rejects(
      () => sendPayment({ dest_features: ['MPP'] }),
      'dest_features[0]: expected a value of lnrpc.FeatureBit'
    );
    rejects(
      () => sendPayment({ dest_features: [12345] }),
      'dest_features[0]: expected a value of lnrpc.FeatureBit'
    );
  });

  it('accepts the oneof property that decoded messages carry', () => {
    updatePolicy({
      scope: 'chan_point',
      chan_point: { funding_txid: 'funding_txid_str', funding_txid_str: 'ab', output_index: 0 },
      base_fee_msat: '1000',
      fee_rate: 0.000001,
      time_lock_delta: 80,
    });
    rejects(
      () => updatePolicy({ scope: 'everything' }),
      'scope: expected one of "global", "chan_point"'
    );
  });

  it('checks that one member of a oneof is set and named', () => {
    rejects(
      () => updatePolicy({ global: true, chan_point: { funding_txid_str: 'ab' } }),
      'lnrpc.PolicyUpdateRequest.chan_point: only one of "global", "chan_point" may be set (oneof scope)'
    );
    rejects(
      () => updatePolicy({ scope: 'global', chan_point: { funding_txid_str: 'ab' } }),
      'lnrpc.PolicyUpdateRequest.scope: names "global", but "chan_point" is set'
    );
    rejects(
      () => updatePolicy({ scope: 'global' }),
      'scope: names "global", but that field is not set'
    );
    updatePolicy({ global: true, scope: 'global' });
  });

  it('accepts only the base64 that protobufjs decodes', () => {
    sendPayment({ dest: 'YWJj', payment_hash: 'YWI', payment_addr: 'YWI=' });
    rejects(
      () => sendPayment({ dest: 'YW-j' }),
      'dest: expected a Buffer, a Uint8Array or a base64 string'
    );
    rejects(
      () => sendPayment({ dest: 'YW_j' }),
      'dest: expected a Buffer, a Uint8Array or a base64 string'
    );
    rejects(
      () => sendPayment({ dest: 'YQ==YQ==' }),
      'dest: expected a Buffer, a Uint8Array or a base64 string'
    );
  });

  it('checks map keys, including binary keys copied from a response', () => {
    rejects(
      () => sendPayment({ dest_custom_records: { '-1': 'YQ==' } }),
      'dest_custom_records["-1"]: expected an integer map key (uint64) from 0 to 18446744073709551615'
    );
    // protobufjs would send these keys as 65536 and 0
    rejects(
      () => sendPayment({ dest_custom_records: { '18446744073709617152': 'YQ==' } }),
      'dest_custom_records["18446744073709617152"]: expected an integer map key (uint64) from 0'
    );
    let addInvoice = request => validators.get('Lightning.addInvoice').validate(request);
    rejects(
      () => addInvoice({ features: { 4294967296: { name: 'x' } } }),
      'lnrpc.Invoice.features["4294967296"]: expected an integer map key (uint32) from 0 to 4294967295'
    );
    addInvoice({ features: { 0: {}, 4294967295: {} } });
    sendPayment({ dest_custom_records: { '18446744073709551615': 'YQ==', '065536': 'YQ==' } });
    rejects(
      () => sendPayment({ dest_custom_records: { 'laÆF\u0001\u0000\u0000\u0000': 'YQ==' } }),
      'this looks like a key decoded from a response, convert it to a decimal string first'
    );
  });

  it('rejects an unknown field even when its value is undefined', () => {
    rejects(
      () => sendPayment({ payment_request: 'lnbc1', amtt: undefined }),
      'amtt: unknown field (did you mean "amt"?)'
    );
  });

  it('checks a request without a client', () => {
    sut.validate('0.20', 'Lightning.addInvoice', { value: 1000 });
    sut.validate(undefined, 'Lightning.AddInvoice', { value: 1000 });
    sut.validate('0.21.5-beta', 'addInvoice', { value: 1000 });
    sut.validate('0.20', 'genSeed', {});
    sut.validate('0.20', 'subscribeState', {});
    let err = (() => {
      try {
        sut.validate('0.20', 'addInvoice', { valeu: 1000 });
      } catch (e) {
        return e;
      }
    })();
    expect(err).to.be.instanceOf(sut.ValidationError);
    expect(err.message).to.equal('lnrpc.Invoice.valeu: unknown field (did you mean "value"?)');
    expect(err.method).to.equal('Lightning.addInvoice');
    // For a bidirectional stream, a message written to it
    rejects(
      () => sut.validate('0.20', 'Router.htlcInterceptor', { action: 'ACCEPT' }),
      'routerrpc.ForwardHtlcInterceptResponse.action: expected a value of'
    );
  });

  it('checks a request of the method in the given line only', () => {
    sut.validate('0.20', 'sendPaymentSync', { payment_request: 'lnbc1' });
    expect(() => sut.validate('0.21', 'sendPaymentSync', {})).to.throw(
      Error,
      'Unknown method "sendPaymentSync" in LND 0.21'
    );
    expect(() => sut.validate('0.20', 'Lightning.noSuchMethod', {})).to.throw(
      'Unknown method "Lightning.noSuchMethod" in LND 0.20'
    );
    expect(() => sut.validate('0.20', 'getinfo', {})).to.throw('Unknown method "getinfo"');
    expect(() => sut.validate('0.17', 'getInfo', {})).to.throw('Unsupported lndVersion "0.17"');
  });

  it('does not take prototype names for fields', () => {
    rejects(() => sendPayment({ constructor: 1 }), 'constructor: unknown field');
    rejects(() => sendPayment(JSON.parse('{"__proto__": {"amt": 1}}')), '__proto__: unknown field');
  });
});
