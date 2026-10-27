// Public half of the release-signing key (scripts/make-signing-key.js). The updater installs only
// releases whose latest.json is signed by the matching private key, which never leaves the
// maintainer's machine.
export const UPDATE_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAlFx8we62uPnxAjxup+oDnepac2VhBT6lYsm57wb3RoM=\n-----END PUBLIC KEY-----\n";
