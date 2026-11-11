// Finds the Developer ID Application identity that signs the DMG, so that the
// certificate's name is not written in the build scripts.
const { execFileSync } = require('child_process');

// Returns the name of the team's Developer ID Application identity from the
// output of `security find-identity -v -p codesigning`. An identity listed
// more than once counts once. Throws when the listing holds none, or more
// than one name, for the team.
function findIdentity(listing, teamId) {
  const names = new Set();
  for (const m of listing.matchAll(/"(Developer ID Application: [^"]* \(([^()"]+)\))"/g)) {
    if (m[2] === teamId) names.add(m[1]);
  }
  if (names.size === 0) throw new Error('no Developer ID Application identity of the team in the keychain search list');
  if (names.size > 1) throw new Error(`${names.size} Developer ID Application identities of the team in the keychain search list`);
  return [...names][0];
}

// The identity of the team among the valid code signing identities in the keychain search list.
function developerIdIdentity(teamId) {
  return findIdentity(
    execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }),
    teamId,
  );
}

module.exports = { findIdentity, developerIdIdentity };
