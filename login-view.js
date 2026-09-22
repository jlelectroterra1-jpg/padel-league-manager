// Organiser/Owner login (login.html). Signs in via auth.js, resolves the
// caller's `organisers` profile row, and redirects based on role+status:
// owner -> owner.html, active organiser -> my-leagues.html, pending/
// suspended -> stays here with an explanatory notice.
(function () {
  const { el } = window.Render;
  const app = document.getElementById("app");

  document.addEventListener("DOMContentLoaded", render);

  function render() {
    app.innerHTML = "";
    if (!window.DB.hasSupabase()) {
      app.appendChild(
        el("div", { class: "card" }, [
          el("h3", {}, "Supabase not configured"),
          el("p", { class: "muted" }, "Organiser accounts need a configured Supabase project (see config.js) - this page can't run against the local fallback storage.")
        ])
      );
      return;
    }
    app.appendChild(loginForm());
  }

  function loginForm() {
    const email = el("input", { class: "input", type: "email", placeholder: "you@example.com", autocomplete: "email" });
    const password = el("input", { class: "input", type: "password", placeholder: "Password", autocomplete: "current-password" });
    const error = el("p", { class: "form-error", hidden: true });
    const submitBtn = el("button", { class: "btn btn-primary", type: "submit" }, "Log in");

    const form = el("form", { class: "card" }, [
      el("h2", {}, "Organiser login"),
      field("Email", email),
      field("Password", password),
      error,
      submitBtn,
      el("p", { class: "muted small" }, ["Don't have an account? ", el("a", { href: "register.html", style: "color:var(--brand)" }, "Sign up")])
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.hidden = true;
      if (!email.value.trim() || !password.value) {
        error.hidden = false;
        error.textContent = "Email and password are required.";
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "Logging in...";
      try {
        const session = await window.Auth.signIn(email.value.trim(), password.value);
        let organiser = await window.DB.dbGet("organisers", session.user.id);
        if (!organiser) {
          // Self-heal: this account signed up while email confirmation was
          // required, so its `organisers` row was never inserted at
          // register-view.js's signup step (no session existed yet then) -
          // do it now, from the metadata GoTrue already stored at signup.
          const meta = session.user.user_metadata || {};
          organiser = await window.DB.dbInsert("organisers", {
            id: session.user.id,
            name: meta.name || session.user.email,
            email: session.user.email,
            phone: meta.phone || null,
            role: "organiser",
            status: "pending"
          });
        }

        if (organiser.role === "owner") {
          location.href = "owner.html";
        } else if (organiser.status === "active") {
          location.href = "my-leagues.html";
        } else {
          app.innerHTML = "";
          app.appendChild(window.Auth.renderStatusNotice(organiser.status));
          app.appendChild(
            el("button", { class: "btn btn-ghost", type: "button", onclick: async () => { await window.Auth.signOut(); render(); } }, "Log out")
          );
        }
      } catch (err) {
        console.error(err);
        submitBtn.disabled = false;
        submitBtn.textContent = "Log in";
        error.hidden = false;
        error.textContent = err.message || "Couldn't log in - please try again.";
      }
    });

    return form;
  }

  function field(label, input) {
    return el("label", { class: "field" }, [el("span", {}, label), input]);
  }
})();
