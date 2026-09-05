# Security policy

## Supported versions

The latest published minor release on npm (`@the-40-thieves/alexandria-mcp`) receives security fixes. Older majors do not.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: open the Security tab and choose "Report a vulnerability", or go to https://github.com/The-40-Thieves/alexandria-mcp/security/advisories/new. Reports are private until a fix is published.

Please include the affected version, the tool or endpoint involved (for example `library_read`, `/mcp`, the fetch tier), and a reproduction. Do not open a public issue for a vulnerability.

You can expect an acknowledgement within 7 days and a fix or a documented mitigation within 30 days for confirmed reports. Credit is given in the release notes unless you ask otherwise.

## Scope notes

Alexandria fetches third-party web content on behalf of an agent. The SSRF guard in `src/web/fetchTier.ts`, the body caps in `src/utils/http.ts`, the `/mcp` origin, host, and rate-limit guards in `src/httpGuards.ts`, and the prompt data fencing in `src/utils/promptData.ts` are the surfaces most worth a second look; `docs/fetch-tier-runtime.md` lists their known limits.
