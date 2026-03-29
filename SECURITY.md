# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Kube-Argus, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **security@YOURDOMAIN.com** *(replace with your fork's contact)*

We will acknowledge receipt within 48 hours and aim to provide a fix within 7 days for critical issues.

## Scope

The following are in scope:
- Authentication bypass
- Session hijacking
- Kubernetes API privilege escalation
- Secret/credential exposure
- Cross-site scripting (XSS) in the dashboard

## Security Considerations

- Kube-Argus requires a Kubernetes service account with read access to cluster resources
- Admin actions (pod delete, exec, scale) are gated behind the admin role
- Session cookies use HMAC-SHA256 signing
- OIDC tokens are verified server-side against the issuer
- No secrets are stored on disk; all configuration is via environment variables or Secrets Manager
