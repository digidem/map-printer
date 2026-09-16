import "./style.css";

const app = document.querySelector("#app");
if (app) {
  const heading = document.createElement("h1");
  heading.textContent = "Map Printer";
  app.append(heading);
}
