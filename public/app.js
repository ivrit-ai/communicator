const who = document.getElementById("who");
const signin = document.getElementById("signin");
const signout = document.getElementById("signout");

async function render() {
  const res = await fetch("/api/me");
  if (!res.ok) {
    who.textContent = "Not signed in.";
    signin.hidden = false;
    signout.hidden = true;
    return;
  }
  const me = await res.json();
  who.textContent = `Signed in as ${me.name ?? me.email} (${me.email})`;
  signin.hidden = true;
  signout.hidden = false;
}

signout.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  await render();
});

render();
