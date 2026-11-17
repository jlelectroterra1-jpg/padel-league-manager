// The demo pages (demo.html, demo-admin.html, demo-team.html) load THIS file
// instead of config.js. It has no database address at all, so the demo can
// never reach the real database: everything runs inside the visitor's own
// browser (db.js's local-storage mode, under its own "pl_demo_" keys, so it
// can't touch anything else either) and nothing is shared or saved anywhere.
window.LEAGUE_CONFIG = { demo: true };
