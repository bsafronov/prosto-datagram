# Wizard-provisioned PostgreSQL is persistent profile infrastructure

When team setup uses the built-in Docker option, `datagram init` creates a dedicated persistent PostgreSQL service owned by the selected Service profile and exposes explicit lifecycle commands for it. Stopping, repairing, reconfiguring, or rerunning setup never removes its data automatically; an existing external PostgreSQL URL remains an alternative. Easy provisioning must not make database ownership, backup responsibility, infrastructure trust, or destructive cleanup implicit.
