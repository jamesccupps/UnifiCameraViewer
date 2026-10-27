// Saves a console's password the way 1.3.x did (the sync safeStorage.encryptString), so the e2e suite
// can check that the async API reads configs from before the upgrade. TEST ONLY.
//
//   electron test/legacy-password.cjs <userData> <consoleId> <password>
const { app, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");

const [dir, id, plain] = process.argv.slice(-3);
app.setPath("userData", dir);
app.whenReady().then(() => {
  const file = path.join(dir, "config.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.consoles.find((c) => c.id === id).password = { enc: "safe", data: safeStorage.encryptString(plain).toString("base64") };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  // quit(), not exit(): the key encryptString just made lives in "Local State", which Chromium only
  // writes on a normal shutdown (or after a ~10 s delay). exit() loses it, and the password with it.
  app.quit();
});
