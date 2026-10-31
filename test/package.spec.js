// The metadata npm shows for the package.
const { execFileSync } = require('child_process');
const path = require('path');
const { expect } = require('chai');
const pkg = require('../package.json');

const REPOSITORY = 'https://github.com/LNBIG-COM/lnd-async';

describe('package.json', () => {
  it('points at the repository the releases come from', () => {
    expect(pkg.repository).to.deep.equal({ type: 'git', url: `git+${REPOSITORY}.git` });
    expect(pkg.homepage).to.equal(`${REPOSITORY}#readme`);
    expect(pkg.bugs).to.deep.equal({ url: `${REPOSITORY}/issues` });
  });

  it('publishes only lib/', function() {
    this.timeout(60000);
    expect(pkg.main).to.equal('lib/lnd-async');
    expect(pkg.types).to.equal('lib/lnd-async.d.ts');
    // What npm would really pack: a file in the working copy must not get into the package
    let [packed] = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    );
    let files = packed.files.map(f => f.path);
    expect(files.filter(f => !f.startsWith('lib/')).sort()).to.deep.equal([
      'LICENSE',
      'README.md',
      'package.json',
    ]);
    expect(files).to.include.members(['lib/lnd-async.js', 'lib/enums.js', 'lib/types/index.d.ts']);
  });
});
