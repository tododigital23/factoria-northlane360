import React from "react";
import { createRoot } from "react-dom/client";
import { Auth0Provider } from "@auth0/auth0-react";
import App from "./App";
import {OwnSessionProvider} from "./auth";
import "./style.css";
import "./office/theme.css";
import "./office/system.css";

const domain = import.meta.env.VITE_AUTH0_DOMAIN;
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID;
const audience = import.meta.env.VITE_AUTH0_AUDIENCE;
const root = createRoot(document.getElementById("root")!);

if (!domain || !clientId || !audience) {
  root.render(<main className="container"><h1>Configuración incompleta</h1><p>Faltan las variables públicas de Auth0.</p></main>);
} else {
  root.render(<React.StrictMode><Auth0Provider domain={domain} clientId={clientId} authorizationParams={{redirect_uri: window.location.origin, audience, scope:"openid profile email read:tasks create:tasks"}} cacheLocation="memory"><OwnSessionProvider><App /></OwnSessionProvider></Auth0Provider></React.StrictMode>);
}
