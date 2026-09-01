/**
 * Supply-chain guard for the iOS pod pins.
 *
 * LibSignalClient is the only pod we clone from a third-party git ref, and it
 * carries the crypto core of the app. A git TAG is a mutable ref: the upstream
 * org can move `v0.98.0` to a different commit and CocoaPods will happily fetch
 * the new bytes. That is not a theoretical shuffle of a Swift shim —
 * `bin/fetch_archive.py`, the script that enforces LIBSIGNAL_FFI_PREBUILD_CHECKSUM
 * (its `assert digest.hexdigest() == checksum.lower()`), is ITSELF fetched from
 * that ref. A moved tag can therefore delete the assert and void the FFI pin,
 * while leaving LibSignalClient.podspec byte-identical so SPEC CHECKSUMS does not
 * move and `git diff` shows nothing. app/ios/Pods/ is gitignored, so every clean
 * `pod install` re-fetches all of it.
 *
 * A commit SHA is content-addressed and cannot be moved. These assertions keep
 * every git-sourced pod on one.
 *
 * AND ON ONE REPOSITORY. Content-addressing is scoped to a repository: our
 * exact 40 hex characters can be pushed into any fork, so a `:git` repointed
 * at `github.com/attacker/libsignal.git` reproduces every failure above while
 * every commit assertion stays true. It is the EASIER attack — moving a tag
 * needs write access upstream; repointing a URL needs a pull request here —
 * and on the next clean `pod install` CocoaPods sees the external source
 * changed, discards CHECKOUT OPTIONS and re-clones from the fork. So the
 * repository is pinned too, on both Podfile arms and in both of the lock's
 * `:git`-bearing blocks, and the two files are required to name the same one.
 */
// `require`, not `import` — the app tsconfig carries no @types/node, so an
// ESM import of a Node builtin fails typecheck. Matches version.test.ts and
// privacy.manifest.test.ts, the other two suites that read repo files. The
// `export {}` below is what keeps these names file-scoped: without it this
// file is a script, and its `readFileSync`/`join` collide in the global scope
// with the identical declarations in those two suites.
export {};

const { readFileSync } = require('fs') as {
  readFileSync: (p: string, enc: string) => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
const { createHash } = require('crypto') as {
  createHash: (alg: string) => { update(s: string): { digest(enc: string): string } };
};

const IOS_DIR = join(__dirname, '..', 'ios');
const PODFILE = join(IOS_DIR, 'Podfile');
const PODFILE_LOCK = join(IOS_DIR, 'Podfile.lock');

/** A 40-hex git object id. */
const SHA1_RE = /^[0-9a-f]{40}$/;

/**
 * The ONE repository each git-sourced pod may be cloned from.
 *
 * A commit SHA is content-addressed *within a repository*, and that is the
 * whole of the guarantee — it says nothing about which repository. Anyone can
 * push our exact 40 hex characters into a fork and then add a commit of their
 * own on top; repointing `:git` is strictly easier than moving a tag, because
 * it needs no write access upstream at all. CocoaPods notices the external
 * source changed, discards CHECKOUT OPTIONS, and re-clones from wherever the
 * new URL names. `app/ios/Pods/` is gitignored and `SPEC CHECKSUMS` does not
 * move, so nothing else in the repo registers it.
 *
 * Keyed by pod name so that a NEW git-sourced pod is a failure until someone
 * writes its repository down here — which is the review this list exists to
 * force.
 */
const APPROVED_GIT_SOURCES: Record<string, string> = {
  LibSignalClient: 'https://github.com/signalapp/libsignal.git',
};

/** The `:git => '…'` URL of a Podfile declaration, if it has one. */
function declaredGitUrl(source: string): string | undefined {
  return /:git\s*=>\s*['"]([^'"]+)['"]/.exec(source)?.[1];
}

/**
 * Every `:git:` value anywhere in a Podfile.lock.
 *
 * The lock names the repository TWICE — once under `EXTERNAL SOURCES:` (what
 * the Podfile asked for, and what CocoaPods diffs against the Podfile to
 * decide whether to re-resolve) and once under `CHECKOUT OPTIONS:` (what it
 * actually cloned). Guarding one block and not the other is the same
 * one-armed edit this file already exists to catch on the Podfile's two
 * targets, so this sweep is deliberately block-agnostic.
 */
function lockGitSources(lock: string): string[] {
  return [...lock.matchAll(/^\s+:git:\s*(\S+?)\s*$/gm)].map((m) => unquote(m[1]));
}

/**
 * Strip a surrounding pair of quotes from a Podfile.lock scalar.
 *
 * CocoaPods emits a bare YAML scalar for `:git:` today but quotes other option
 * values in the same blocks (`:path:`, `:podspec:`). A future dumper that
 * quoted this one would otherwise make the approved URL read as an unapproved
 * one — a false RED that blocks a legitimate `pod install`, which is how a
 * guard gets deleted rather than fixed.
 */
function unquote(value: string): string {
  return value.replace(/^["'](.*)["']$/, '$1');
}

/**
 * The Podfile option keys this guard reasons about. Used only to normalise
 * Ruby 1.9 syntax (below) — deliberately a closed list rather than a generic
 * `\w+:` so that a URL scheme (`git://…`) or a Ruby namespace (`Pod::…`) can
 * never be mistaken for a hash key.
 */
const OPTION_KEYS = ['git', 'tag', 'branch', 'commit', 'submodules', 'podspec', 'path'];

/**
 * Rewrite Ruby 1.9 hash keys into the hash-rocket form.
 *
 *   tag: 'v0.98.0'   ->   :tag => 'v0.98.0'
 *
 * Ruby parses the two to the identical hash and CocoaPods accepts both, so a
 * guard that only matches `:tag =>` is blind to half the ways a mutable ref can
 * be written. It is not a hypothetical: a mutable `tag:` pin on the NSE arm
 * scored a full green against the hash-rocket-only version of this file.
 *
 * The colon must be followed by whitespace or a quote, and the key must be
 * preceded by a line start, whitespace, comma or bracket. That pair of
 * conditions is what keeps `'git://…'` and `Pod::Executable` out.
 */
const RUBY19_KEY = new RegExp(`(^|[\\s,({])(${OPTION_KEYS.join('|')})\\s*:(?=\\s|['"])`, 'gm');

function normaliseHashKeys(source: string): string {
  return source.replace(RUBY19_KEY, '$1:$2 =>');
}

/**
 * Drop a trailing `# …` comment, respecting quotes so that the `#` of a Ruby
 * interpolation (`"#{Pod::Config.instance.installation_root}/.."`) survives.
 */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Pull the `CHECKOUT OPTIONS:` block out of a Podfile.lock.
 * Shape (2-space pod names, 4-space option keys):
 *
 *   CHECKOUT OPTIONS:
 *     LibSignalClient:
 *       :git: https://github.com/signalapp/libsignal.git
 *       :commit: 8e49f09b...
 */
function parseCheckoutOptions(lock: string): Record<string, Record<string, string>> {
  const lines = lock.split('\n');
  const start = lines.findIndex((l) => l === 'CHECKOUT OPTIONS:');
  if (start === -1) return {};

  const out: Record<string, Record<string, string>> = {};
  let current: string | null = null;

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    // A non-indented line ends the block (e.g. `SPEC CHECKSUMS:`).
    if (!line.startsWith(' ')) break;

    const pod = /^ {2}([^\s:][^:]*):\s*$/.exec(line);
    if (pod) {
      current = pod[1];
      out[current] = {};
      continue;
    }
    const opt = /^ {4}(:[a-z_]+):\s*(.*)$/.exec(line);
    if (opt && current) out[current][opt[1]] = opt[2].trim();
  }
  return out;
}

/**
 * Collect every `pod '<Name>', <options...>` statement from the Podfile,
 * following continuation lines (a wrapped option line is indented and starts
 * with `:`). Returns one flattened source string per declaration — normalised
 * to hash-rocket syntax — so a one-armed edit (fixing target 'Tacendum' but
 * leaving 'TacendumNSE' on a mutable ref) is caught rather than averaged away.
 *
 * Comment lines *inside* a declaration are skipped, not treated as the end of
 * it. Consuming one used to truncate the scan — the comment does not end in a
 * comma, so everything after it, including the `:git`/`:tag` lines, fell out of
 * `source` and every assertion below went vacuously green. Given how heavily
 * commented the real declarations are, that was one stray explanatory line away
 * from being live.
 */
function parsePodDeclarations(podfile: string): { name: string; source: string }[] {
  const lines = normaliseHashKeys(podfile).split('\n').map(stripComment);
  const decls: { name: string; source: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*pod\s+['"]([^'"]+)['"]/.exec(lines[i]);
    if (!head) continue;

    const parts = [lines[i].trim()];
    const open = () => parts[parts.length - 1].endsWith(',');
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      // A comment-only or blank line: keep scanning while the statement is
      // still open (its last code line ended in a comma), else stop.
      if (next === '') {
        if (open()) continue;
        break;
      }
      // Continuation: an option key, or the tail of a wrapped value.
      if (!next.startsWith(':') && !open()) break;
      parts.push(next);
      if (!next.endsWith(',')) break;
    }
    decls.push({ name: head[1], source: parts.join(' ') });
  }
  return decls;
}

describe('iOS pod pins are immutable', () => {
  const podfile = readFileSync(PODFILE, 'utf8');
  const lock = readFileSync(PODFILE_LOCK, 'utf8');
  const decls = parsePodDeclarations(podfile);

  describe('Podfile.lock CHECKOUT OPTIONS', () => {
    const checkouts = parseCheckoutOptions(lock);

    it('records at least one git-sourced pod (the parser is not silently empty)', () => {
      // Guards the guard: a parser that matches nothing would make every
      // assertion below vacuously pass.
      expect(Object.keys(checkouts).length).toBeGreaterThan(0);
      expect(Object.keys(checkouts)).toContain('LibSignalClient');
    });

    it.each(Object.keys(parseCheckoutOptions(readFileSync(PODFILE_LOCK, 'utf8'))))(
      '%s is locked to a commit SHA, not a movable ref',
      (name) => {
        const opts = checkouts[name];
        expect(opts).toBeDefined();

        // A tag or branch can be repointed upstream at any time; the lock then
        // authorises fetching bytes nobody in this repo has ever reviewed.
        expect(opts[':tag']).toBeUndefined();
        expect(opts[':branch']).toBeUndefined();

        expect(opts[':commit']).toBeDefined();
        expect(opts[':commit']).toMatch(SHA1_RE);
      },
    );

    it.each(Object.keys(parseCheckoutOptions(readFileSync(PODFILE_LOCK, 'utf8'))))(
      '%s was checked out from its approved repository',
      (name) => {
        // Without this, the commit assertions above are satisfied by an
        // attacker's fork carrying our exact SHA plus whatever they added.
        // Compared as a labelled pair so a failure names the pod and both URLs,
        // and so a lock that dropped `:git` altogether reads as `<none>`
        // rather than passing an `undefined === undefined` comparison.
        const opts = checkouts[name];
        expect(`${name} :git=${opts[':git'] ? unquote(opts[':git']) : '<none>'}`).toBe(
          `${name} :git=${APPROVED_GIT_SOURCES[name] ?? '<no approved repository for this pod>'}`,
        );
      },
    );

    it('names no repository outside the approved list, in EITHER lock block', () => {
      // Set equality in both directions, which also guards the guard: a sweep
      // that matched nothing would compare `[]` against the approved list and
      // fail rather than pass vacuously.
      expect([...new Set(lockGitSources(lock))].sort()).toEqual(
        [...new Set(Object.values(APPROVED_GIT_SOURCES))].sort(),
      );
    });
  });

  describe('Podfile pod declarations', () => {
    it('finds the LibSignalClient declaration on BOTH targets', () => {
      // The pod is declared twice on purpose: once for the app target and once
      // for the notification-service extension, which is a sibling target and
      // inherits nothing. Pinning one arm and not the other still leaves a
      // mutable fetch in the build. This count is the partial-mirror tripwire.
      const libsignal = decls.filter((d) => d.name === 'LibSignalClient');
      expect(libsignal).toHaveLength(2);
    });

    it.each(parsePodDeclarations(readFileSync(PODFILE, 'utf8')).map((d) => [d.name, d.source]))(
      'pod %s declares no mutable git ref',
      (_name, source) => {
        expect(source).not.toMatch(/:tag\s*=>/);
        expect(source).not.toMatch(/:branch\s*=>/);
      },
    );

    it('every git-sourced pod declares a 40-hex :commit', () => {
      const gitPods = decls.filter((d) => /:git\s*=>/.test(d.source));
      expect(gitPods.length).toBeGreaterThan(0);

      for (const { name, source } of gitPods) {
        const commit = /:commit\s*=>\s*['"]([^'"]+)['"]/.exec(source);
        expect(`${name}: ${commit?.[1] ?? '<none>'}`).toMatch(
          new RegExp(`^${name}: [0-9a-f]{40}$`),
        );
      }
    });

    it.each(
      parsePodDeclarations(readFileSync(PODFILE, 'utf8'))
        .filter((d) => /:git\s*=>/.test(d.source))
        .map((d) => [d.name, d.source]),
    )('pod %s is declared against its approved repository', (name, source) => {
      // Per DECLARATION, not per pod: LibSignalClient is declared twice, and
      // repointing one arm leaves the extension — which decrypts payloads with
      // the same libsignal — cloning from somewhere nobody reviewed.
      expect(`${name} :git=${declaredGitUrl(source) ?? '<none>'}`).toBe(
        `${name} :git=${APPROVED_GIT_SOURCES[name] ?? '<no approved repository for this pod>'}`,
      );
    });
  });

  describe('Podfile and Podfile.lock agree', () => {
    // Without this pair, pinning the Podfile to one commit while the lock keeps
    // another is a full green: the Podfile assertions read the Podfile and the
    // CHECKOUT OPTIONS assertions read the lock, and nothing compares them.
    // A merge that resolves in favour of the incoming lock, or a pin bump made
    // without re-running `pod install`, then ships the OLD commit while the
    // Podfile every reviewer reads claims the new one. Xcode does not catch it
    // either: its `[CP] Check Pods Manifest.lock` phase compares Podfile.lock
    // to Pods/Manifest.lock, so a stale pair stays stale and in agreement.

    it('PODFILE CHECKSUM in the lock is sha1 of the Podfile on disk', () => {
      // CocoaPods writes this on every `pod install`; it is literally
      // sha1(app/ios/Podfile). If this fails, the lock was not regenerated for
      // the current Podfile — run `pod install` in app/ios and commit the lock.
      // (The Podfile is UTF-8, so hashing the decoded string reproduces the
      // file's bytes exactly.)
      const m = /^PODFILE CHECKSUM: ([0-9a-f]{40})$/m.exec(lock);
      expect(m).not.toBeNull();
      const onDisk = createHash('sha1').update(podfile).digest('hex');
      expect(m![1]).toBe(onDisk);
    });

    it('every Podfile git pin equals the commit the lock checked out', () => {
      const checkouts = parseCheckoutOptions(lock);
      const gitPods = decls.filter((d) => /:git\s*=>/.test(d.source));
      expect(gitPods.length).toBeGreaterThan(0);

      for (const { name, source } of gitPods) {
        const declared = /:commit\s*=>\s*['"]([^'"]+)['"]/.exec(source)?.[1];
        // Compared as a labelled pair so a failure names the pod and both
        // values, and so the two arms of a duplicated declaration are each
        // checked rather than averaged.
        expect(`${name} podfile=${declared ?? '<none>'}`).toBe(
          `${name} podfile=${checkouts[name]?.[':commit'] ?? '<none>'}`,
        );
      }
    });

    it('every Podfile git URL equals the repository the lock checked out', () => {
      // The commit-agreement test above compares `:commit` and nothing else,
      // so a Podfile reading `attacker/libsignal.git` and a lock reading
      // `signalapp/libsignal.git` — the exact disagreement this describe block
      // is named for — used to pass it. The Podfile is what a reviewer reads
      // and what CocoaPods re-resolves from, so a mismatch here means the next
      // clean `pod install` fetches something the lock never blessed.
      // REDUNDANCY, MEASURED AND KEPT ON PURPOSE. Against the six repository
      // mutations this file was built from, `{whole-lock sweep, this}` is a
      // minimal cover: the two name-bound assertions (`… was checked out from
      // its approved repository`, `pod … is declared against its approved
      // repository`) never fire alone, and neither does this one. Any ONE of
      // the three can be deleted and every mutation is still caught; all three
      // cannot. They are kept because they differ in what they BIND — this one
      // binds the two files to each other, the other two bind a pod NAME to a
      // repository — and the day `APPROVED_GIT_SOURCES` gains a second entry
      // (a mirror, a vendored fork) that difference stops being cosmetic: a
      // Podfile on one approved URL and a lock on the other passes both
      // allowlists, and this is the only assertion left standing between them.
      const checkouts = parseCheckoutOptions(lock);
      const gitPods = decls.filter((d) => /:git\s*=>/.test(d.source));
      expect(gitPods.length).toBeGreaterThan(0);

      for (const { name, source } of gitPods) {
        expect(`${name} podfile=${declaredGitUrl(source) ?? '<none>'}`).toBe(
          `${name} podfile=${checkouts[name]?.[':git'] ?? '<none>'}`,
        );
      }
    });
  });

  describe('the guard understands the syntaxes CocoaPods accepts', () => {
    // Guards the guard, on synthetic input. The real Podfile uses hash rockets
    // and no interposed comments, so without these the normaliser and the
    // comment-skipping could both rot to no-ops and every assertion above would
    // stay green while going blind.
    const ruby19 = [
      "target 'X' do",
      "  pod 'LibSignalClient',",
      "      git: 'https://github.com/signalapp/libsignal.git',",
      "      tag: 'v0.98.0'",
      'end',
    ].join('\n');

    const commented = [
      "target 'X' do",
      "  pod 'LibSignalClient',",
      '      # pinned to the release tag; see the notes above',
      "      :git => 'https://github.com/signalapp/libsignal.git',",
      "      :tag => 'v0.98.0'",
      'end',
    ].join('\n');

    it.each([
      ['Ruby 1.9 hash keys', ruby19],
      ['a comment interposed inside the declaration', commented],
      ['both at once', normaliseHashKeys(commented).replace(':tag =>', 'tag:')],
    ])('sees the mutable ref through %s', (_label, fixture) => {
      const [decl] = parsePodDeclarations(fixture);
      expect(decl).toBeDefined();
      expect(decl.name).toBe('LibSignalClient');
      expect(decl.source).toMatch(/:git\s*=>/);
      expect(decl.source).toMatch(/:tag\s*=>/);
    });

    it('does not mistake a URL scheme or a Ruby namespace for a hash key', () => {
      expect(normaliseHashKeys("'git://example.invalid/x.git'")).toBe(
        "'git://example.invalid/x.git'",
      );
      expect(normaliseHashKeys('Pod::Executable.execute_command')).toBe(
        'Pod::Executable.execute_command',
      );
    });

    it('reads the lock’s :git whether or not the dumper quoted it', () => {
      // Both spellings are valid YAML for the same scalar. Without this the
      // unquoting is untested logic, and untested logic in a guard is the
      // thing that rots first.
      const bare = ['CHECKOUT OPTIONS:', '  P:', '    :git: https://example.invalid/p.git'].join(
        '\n',
      );
      const quoted = [
        'CHECKOUT OPTIONS:',
        '  P:',
        '    :git: "https://example.invalid/p.git"',
      ].join('\n');
      expect(lockGitSources(bare)).toEqual(['https://example.invalid/p.git']);
      expect(lockGitSources(quoted)).toEqual(['https://example.invalid/p.git']);
      expect(unquote(parseCheckoutOptions(quoted)['P'][':git'])).toBe(
        'https://example.invalid/p.git',
      );
    });

    it('keeps a Ruby interpolation intact when stripping comments', () => {
      expect(stripComment('  :app_path => "#{Pod::Config.instance.root}/.." # note')).toBe(
        '  :app_path => "#{Pod::Config.instance.root}/.." ',
      );
    });
  });

  describe('libsignal FFI archive stays content-pinned', () => {
    it('Podfile still sets LIBSIGNAL_FFI_PREBUILD_CHECKSUM to a SHA-256', () => {
      // The commit pin protects the checked-out sources INCLUDING the enforcer
      // script; this checksum is what the enforcer enforces. Both controls are
      // load-bearing, so neither may quietly disappear.
      const m = /LIBSIGNAL_FFI_PREBUILD_CHECKSUM'\]\s*=\s*\n?\s*'([0-9a-f]{64})'/.exec(podfile);
      expect(m).not.toBeNull();
    });
  });
});
