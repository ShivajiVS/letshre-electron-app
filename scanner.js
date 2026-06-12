const { exec } = require("child_process");

const blockedApps = [
  "zoom.exe",
  // "teams.exe",
  // "obs64.exe",
  "anydesk.exe",
  "teamviewer.exe",
  "bandicam.exe",
  "camtasia.exe",
];

function scanProcesses(callback) {
  exec("tasklist", (err, stdout) => {
    if (err) return callback([]);

    let found = [];

    blockedApps.forEach((app) => {
      if (stdout.toLowerCase().includes(app.toLowerCase())) {
        found.push(app);
      }
    });

    callback(found);
  });
}

module.exports = scanProcesses;
