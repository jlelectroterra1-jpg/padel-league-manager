// Small localStorage helpers for remembering "who's looking at this browser".
(function () {
  const TEAM_CODE_KEY = "pl_team_code";
  const ADMIN_LEAGUE_KEY = "pl_admin_league";

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
