// Small localStorage helpers for remembering "who's looking at this browser".
(function () {
  // The demo pages use their own keys so trying the demo never changes which
  // real team (or league) this browser remembers.
  const PREFIX = window.LEAGUE_CONFIG && window.LEAGUE_CONFIG.demo ? "pl_demo_" : "pl_";
  const TEAM_CODE_KEY = PREFIX + "team_code";
  const ADMIN_LEAGUE_KEY = PREFIX + "admin_league";

  function rememberTeamCode(code) {
    localStorage.setItem(TEAM_CODE_KEY, code);
  }
  function getRememberedTeamCode() {
    return localStorage.getItem(TEAM_CODE_KEY);
  }
  function forgetTeamCode() {
    localStorage.removeItem(TEAM_CODE_KEY);
  }
  function rememberAdminLeague(id) {
    localStorage.setItem(ADMIN_LEAGUE_KEY, id);
  }
  function getRememberedAdminLeague() {
    return localStorage.getItem(ADMIN_LEAGUE_KEY);
  }

  window.State = {
    rememberTeamCode,
    getRememberedTeamCode,
    forgetTeamCode,
    rememberAdminLeague,
    getRememberedAdminLeague
  };
})();
