// The metadata npm shows for the package.
const { expect } = require('chai');
const pkg = require('../package.json');

const REPOSITORY = 'https://github.com/LNBIG-COM/lnd-async';

describe('package.json', () => {
  it('points at the repository the releases come from', () => {
    expect(pkg.repository).to.deep.equal({ type: 'git', url: `git+${REPOSITORY}.git` });
    expect(pkg.homepage).to.equal(`${REPOSITORY}#readme`);
    expect(pkg.bugs).to.deep.equal({ url: `${REPOSITORY}/issues` });
  });

  it('publishes only lib/', () => {
    expect(pkg.files).to.deep.equal(['lib']);
    expect(pkg.main).to.equal('lib/lnd-async');
    expect(pkg.types).to.equal('lib/lnd-async.d.ts');
  });
});
