# Steering: authentication is outside Entropi

**Decision.** Entropi does not log anyone in. No OIDC, no Keycloak client, no token exchange, no user database. Login is an infrastructure concern: in Kubernetes the ingress (with oauth2-proxy or similar) authenticates the person and Entropi is only reachable through it. Keeping an identity provider inside the core would tie the product to one vendor, add a large attack surface, and duplicate what every platform team already runs.

**What the core expects.** One thing: a stable user id for each request, and optionally a display name and roles. The id becomes the actor `human:<id>` and is the only identity the core keeps; names are snapshots. Roles are the ladder `viewer < operator < approver < admin`; anything else is ignored, and with no roles a person is a viewer. Roles are refreshed from the proxy on every request, so revoking access upstream takes effect immediately.

**Two modes, nothing else** (`AUTH_MODE`):
- `dev` (default): a local picker (`/auth/login?as=alice`) that sets a signed cookie. For laptops and tests. Never in a cluster.
- `proxy`: trust the identity a reverse proxy puts in a header. It is only active when `AUTH_MODE=proxy` is set explicitly. `AUTH_USER_HEADER` (default `x-forwarded-user`) is required; `AUTH_NAME_HEADER` and `AUTH_ROLES_HEADER` (comma separated) are optional; `AUTH_DEFAULT_ROLES` (default `viewer`) applies when no roles header is configured or sent; `AUTH_LOGOUT_URL` is where "sign out" goes (e.g. `/oauth2/sign_out`).

**Wiring the proxy.** Put Entropi behind an ingress that forces authentication and sets the header from the verified identity, and make sure a client can never set that header itself: the proxy must overwrite or strip it, and Entropi must not be reachable except through the proxy (a NetworkPolicy allowing only the ingress controller is enough). For oauth2-proxy run it with `--set-xauth-request=true` and have the ingress copy `X-Auth-Request-User` (and, for roles, `X-Auth-Request-Groups` mapped to the role names) into the headers above. If that guarantee cannot be given, do not use proxy mode: whoever can reach the port can claim any identity.
