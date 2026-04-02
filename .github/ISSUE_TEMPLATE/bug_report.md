---
name: Bug Report
about: Report a bug to help us improve Kube-Argus
title: "[Bug] "
labels: bug
assignees: ''
---

**Describe the bug**
A clear and concise description of what the bug is.

**To reproduce**
Steps to reproduce the behavior:
1. Go to '...'
2. Click on '...'
3. See error

**Expected behavior**
What you expected to happen.

**Screenshots**
If applicable, add screenshots to help explain your problem.

**Environment**
- Kube-Argus version (Docker image tag):
- Kubernetes version (`kubectl version`):
- Cloud provider: [e.g. EKS, GKE, AKS, Minikube, kind]
- Browser: [e.g. Chrome 120, Firefox 121]
- Auth mode: [Google SSO / OIDC / None]
- Deployed via: [Helm / kubectl / Docker]

**Logs**
If applicable, paste relevant logs from the Kube-Argus pod:
```
kubectl logs -n kube-argus deployment/kube-argus --tail=50
```

**Additional context**
Add any other context about the problem here.
