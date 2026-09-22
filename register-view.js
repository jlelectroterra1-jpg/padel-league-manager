// Public organiser self-registration (register.html). Creates a Supabase
// Auth user via the normal public sign-up endpoint (auth.js) and a matching
// `organisers` profile row, pinned to role=organiser/status=pending by the
// RLS insert policy regardless of what's sent here - an Owner has to
// approve the account (owner.html) before it can sign in anywhere useful.
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
    app.appendChild(registerForm());
  }

  function registerForm() {
    const name = el("input", { class: "input", placeholder: "Your name", autocomplete: "name" });
    const email = el("input", { class: "input", type: "email", placeholder: "you@example.com", autocomplete: "email" });
    const phone = el("input", { class: "input", type: "tel", placeholder: "Optional", autocomplete: "tel" });
    const password = el("input", { class: "input", type: "password", placeholder: "At least 6 characters", autocomplete: "new-password" });
    const confirmPassword = el("input", { class: "input", type: "password", placeholder: "Re-enter your password", autocomplete: "new-password" });
    const error = el("p", { class: "form-error", hidden: true });
    const submitBtn = el("button", { class: "btn btn-primary", type: "submit" }, "Create organiser account");

    const form = el("form", { class: "card" }, [
      el("h2", {}, "Organiser sign up"),
      el("p", { class: "muted small" }, "Create your organiser account, then wait for the league owner to approve it before you can access My Leagues."),
      field("Name", name),
      field("Email", email),
      field("Phone", phone),
      field("Password", password),
      field("Confirm password", confirmPassword),
      error,
      submitBtn,
      el("p", { class: "muted small" }, ["Already registered? ", el("a", { href: "login.html", style: "color:var(--brand)" }, "Log in")])
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.hidden = true;

      if (!name.value.trim() || !email.value.trim() || !password.value) {
        error.hidden = false;
        error.textContent = "Name, email and password are required.";
        return;
      }
      if (password.value.length < 6) {
        error.hidden = false;
        error.textContent = "Password must be at least 6 characters.";
        return;
      }
      if (password.value !== confirmPassword.value) {
        error.hidden = false;
        error.textContent = "Passwords don't match.";
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "Creating account...";
      try {
        const { user, session } = await window.Auth.signUp(email.value.trim(), password.value, {
          name: name.value.trim(),
          phone: phone.value.trim() || null
        });

        if (session) {
          // A session means email confirmation is off, so we're already
          // signed in as this brand-new user - insert their profile row now
          // while auth.uid() matches (required by the RLS insert policy).
          await window.DB.dbInsert("organisers", {
            id: user.id,
            name: name.value.trim(),
            email: email.value.trim(),
            phone: phone.value.trim() || null,
            role: "organiser",
            status: "pending"
          });
          app.innerHTML = "";
          app.appendChild(window.Auth.renderStatusNotice("pending"));
        } else {
          app.innerHTML = "";
          app.appendChild(
            el("div", { class: "card" }, [
              el("h3", {}, "Check your email"),
              el("p", { class: "muted" }, "We've sent a confirmation link to your email. Once confirmed, log in and your account will show as pending approval.")
            ])
          );
        }
      } catch (err) {
        console.error(err);
        submitBtn.disabled = false;
        submitBtn.textContent = "Create organiser account";
        error.hidden = false;
        error.textContent = err.message || "Couldn't create your account - please try again.";
      }
    });

    return form;
  }

  function field(label, input) {
    return el("label", { class: "field" }, [el("span", {}, label), input]);
  }
})();
