# Prosto.Datagram Product Context

Prosto.Datagram helps small operational teams manage shared conversations and structured data through one consistent Channel model and a flat Channel List.

## Language

**Channel**:
A top-level collaboration identity associated with one primary Channel Entity. A Channel is the common boundary for its title, icon, permissions, activity, notifications, and navigation.
_Avoid_: Folder, workspace, project, UI container

**Channel Owner**:
The single person with final authority over a Channel. The creator is the first Channel Owner, ownership can be transferred, and the Owner cannot leave the Datagram Service until every owned Channel has another Owner.
_Avoid_: Workspace administrator, system administrator, permanent creator

**Channel Role**:
A Channel-scoped permission template assigned to a person. Initial roles are Owner, Admin, Contributor, and Viewer; each Channel Type maps its actions to these roles.
_Avoid_: Global role, record ownership, interface-specific permission

**Datagram Service**:
One authoritative Datagram runtime with its own identity realm, approved Channel Types, Store, and event stream. A Local Service starts with one automatic owner; a Server Service adds people through invitations. Identities do not span Services in the first release.
_Avoid_: Workspace, global account, synchronized replica

**Deployment Operator**:
A Service-level administrator who configures the Datagram Service and approves or installs Channel Types. This application authority does not grant Channel access and is separate from every Channel Role; the Local Service owner is also its first Deployment Operator. A person controlling the underlying host or database remains inside the infrastructure trust boundary and can inspect unencrypted storage until end-to-end encryption exists.
_Avoid_: Channel Owner, data administrator, automatic Channel member

**Contributor**:
The Channel Role for normal work with Channel Records without Channel administration. A Contributor can edit any Table Record regardless of its creator but cannot manage people, permissions, schemas, integrations, ownership, or Channel deletion.
_Avoid_: Admin, record owner, read-only member

**Channel Entity**:
The primary thing that people work with through a Channel, such as a conversation, Table, Chart, or Workflow.
_Avoid_: Surface, module, page, resource

**Channel Discussion**:
The message stream available in every Channel. A Conversation Channel makes this stream its primary experience, while other Channel Types expose it as secondary discussion beside their primary Channel Entity.
_Avoid_: Separate discussion Channel, Channel Activity log, type-specific comment system

**Direct Conversation**:
A Conversation Channel uniquely associated with one unordered pair of people in a Datagram Service. Its two-person membership is fixed, adding another person creates a Group Conversation, and neither participant may delete the Channel for the other; each may Archive it personally.
_Avoid_: Two-person Group Conversation, repeat direct chat, shared deletion

**Group Conversation**:
A Conversation Channel with normal Channel membership, roles, sharing, ownership, and deletion rules. It is created instead of changing a Direct Conversation when more people must participate.
_Avoid_: Direct Conversation with added members, workspace, nested group

**Message**:
A revisioned item in a Channel Discussion. Contributors may create Messages and edit or tombstone their own; Admins and Owners may moderate any Message. A Message may reference another Message as a reply or another Channel Record for contextual discussion, but nested discussion threads and per-record subchannels are not part of the first release.
_Avoid_: Channel Activity, mutable text without history, nested thread

**Asset**:
A Channel-scoped file referenced by Messages or, later, File Fields. Asset access follows the referencing Channel's permissions; an Asset is stored through local file storage or a server object-store adapter and does not become its own Channel.
_Avoid_: File Channel, public blob URL, model attachment

**Channel Invitation**:
An expiring, scoped offer created by a Channel Owner or Admin that identifies one Channel and proposed Channel Role. Acceptance adds an existing Service member or creates a Service-local identity before granting the role.
_Avoid_: Global invitation, reusable access link, workspace membership

**Channel Type**:
A versioned, Datagram-owned definition of one kind of Channel Entity. It defines the entity's data rules, actions, state transitions, Channel Activity semantics, presentation meaning, and agent capabilities.
_Avoid_: Plugin, Prosto Designer Plugin, hardcoded feature

**Channel Action**:
A typed, discoverable request declared by a Channel Type that may change Datagram state. UI, CLI, MCP, AI Agent, and Workflow clients submit the same Action contract, and every accepted Action produces an Operation.
_Avoid_: UI handler, direct database write, agent-only tool

**Channel Query**:
A typed, discoverable read declared by a Channel Type. Human-facing hosts may render returned values, while AI Agent calls receive Result Handles and non-data execution status under the zero-data boundary.
_Avoid_: Raw SQL, privileged model read, interface-specific endpoint

**Channel Type Version**:
The immutable Channel Type revision pinned by a Channel. Moving a Channel to another version is an explicit, previewed Type Upgrade Operation approved by its Owner; a Deployment Operator may disable an unsafe version without gaining access to Channel data.
_Avoid_: Automatically floating dependency, application release, silent migration

**View Definition**:
A host-neutral semantic JSON description produced or declared by a Channel Type. It describes meaning, data bindings, and available commands without embedding React, HTML, terminal formatting, or another host implementation; unsupported hosts use a generic rendering fallback.
_Avoid_: Component tree, webpage, host-specific UI

**Flat Channel List**:
The primary navigation list where all accessible Channels are peers, without workspace switching or nested domain navigation. A person can organize this list with Channel Groups, while recent Channel Activity can move any Channel toward the top independent of its Channel Entity type.
_Avoid_: Folder tree, entity hierarchy, separate feature navigation

**Channel Group**:
A person-scoped, overlapping navigation grouping of Channels in the Flat Channel List. One Channel can appear in many Channel Groups; group-specific order and pinning do not change Channel ownership, permissions, or domain structure.
_Avoid_: Workspace, ownership group, nested Channel

**Channel Activity**:
A meaningful change declared by a Channel Type that can notify a person and change the Channel's recency, such as a new message or a new Table record. Many underlying changes can produce one Channel Activity, while background recalculation need not produce any.
_Avoid_: UI refresh, navigation event

**Deleted Channel**:
A shared, recoverable lifecycle state that hides a Channel from normal use without purging its data. Channel References to it become unresolved until restoration; permanent purge remains a separate destructive Operation.
_Avoid_: Archived Channel, personal hide, immediate purge

**Unread Activity**:
Channel Activity newer than a person's last-read position in that Channel. Unread state is independent from notification settings and counts meaningful Activities rather than changed Channel Records.
_Avoid_: Unread record, notification count, unseen mutation

**Notification Delivery**:
The mechanism that alerts a person about Channel Activity. The first release delivers Unread Activity and realtime client events; email, mobile push, and external delivery adapters are deferred.
_Avoid_: Channel Activity, Unread Activity, mandatory email service

**Channel Record**:
A Channel Type-specific item within a Channel Entity, such as a Message, Table Record, or Workflow Run. Channel Records share product-wide collaboration behavior but do not use one universal data shape.
_Avoid_: Universal record, generic row, global entity

**Channel Reference**:
A stable link from one Channel Entity or Channel Record to another inside the same Datagram Service. It does not transfer ownership or access, and it remains unresolved rather than cascading deletion when its target is unavailable; Channel Bundles provide explicit transfer between Services.
_Avoid_: Copied value, ownership link, cascading relation

**Table Field**:
A typed value definition in a Table. Table Fields can be added while data exists, can declare `required`, `unique`, and constant `default` constraints, and require an explicit conversion decision when their type changes.
_Avoid_: Untyped property, mixed-type column, physical database column

**Display Field**:
The Text or Dictionary Field selected to identify a Table Record to people. A Table without a Display Field uses the Record's stable identity until composite display values are supported.
_Avoid_: Primary key, record identity, computed label

**Table View**:
A named selection of visible Fields, filters, sorting, and grouping within one Table Channel. A Table View may be personal or shared but does not become another Channel unless it needs independent permissions, Channel Activity, or notifications.
_Avoid_: Copied Table, Chart Channel, mandatory navigation item

**Tombstoned Field**:
A removed Table Field hidden from the active schema while its definition and stored values remain available for restore and undo. Permanent purge is a separate approved Operation.
_Avoid_: Deleted data, active Field, hidden UI column

**Tombstoned Record**:
A deleted Table Record hidden from active use while retaining its stable identity and values for restore. References show a deleted target until restoration; permanent purge is separate and never cascades.
_Avoid_: Purged Record, missing identity, cascading delete

**Field Type Conversion**:
An explicit schema-change Operation that previews conversion failures before replacing a Table Field's declared type. Each failed value must be corrected, mapped, explicitly replaced with `null` when allowed, or cause cancellation; original values remain recoverable until purge.
_Avoid_: Silent coercion, in-place lossy cast, automatic nulling

**Edit Conflict**:
A concurrent attempt to change a Field whose value changed after the editor's observed version. Changes to different Fields can merge, but a stale same-Field change must be rejected with the current value.
_Avoid_: Last-write-wins overwrite, whole-record lock

**Dictionary**:
A Channel Entity containing uniquely identified values that are primarily consumed by Table Fields. A Dictionary provides a shared validation vocabulary, such as Products or Countries.
_Avoid_: Enum, copied option list, generic Table

**Dictionary Entry**:
A stable value in a Dictionary, with a unique label and its own identity. Labels are trimmed, Unicode-normalized, and unique without regard to case while preserving display casing; references store identity so a label can change without breaking existing data.
_Avoid_: Copied label, free-text option

**Retired Dictionary Entry**:
A Dictionary Entry unavailable for new selections while remaining resolvable and visible in existing Records. Permanent purge is a separate Operation and makes surviving references unresolved.
_Avoid_: Immediately deleted value, selectable Entry, cascading deletion

**Dictionary Field**:
A Table Field whose value is the identity of an existing Dictionary Entry from one selected Dictionary. A Table Record is invalid when its Dictionary Field points to a value outside that Dictionary.
_Avoid_: Free-text Field, embedded option list

**Record Reference Field**:
A Table Field that links to Channel Records in one selected target Channel. It has `one` or `many` cardinality and stores stable record identities rather than copied display values.
_Avoid_: Channel Record Reference, copied foreign value, Dictionary Field

**Chart**:
A derived Channel Entity that stores a live data-selection and aggregation definition rather than copied source records. Ordinary source changes do not create Chart Channel Activity unless an explicit Chart rule produces an insight, threshold event, or report.
_Avoid_: Data copy, static image, Table view

**Operation**:
One atomic intent that changes Datagram state. Every write interface creates an Operation that records its actor, origin, changes, and result and can support conflict-safe undo when its effects are reversible.
_Avoid_: UI action, direct write, untracked mutation

**Operation History**:
The detailed audit and revision record behind Operations. Owners and Admins may inspect full Channel history, Contributors may inspect their own Operations, and Viewers receive only currently permitted state; Deployment Operators receive Service health metadata without Channel data.
_Avoid_: Channel Activity feed, operator data access, universally visible revisions

**Deactivated Person**:
A Service-local identity that can no longer act. Existing authorship remains linked to its stable identity and displays a deactivated profile; owned Channels must be transferred before deactivation, while permanent identity purge may anonymize profile attributes without rewriting Operation History.
_Avoid_: Deleted author, reassigned content, erased audit actor

**AI Agent**:
A zero-data planning and orchestration layer available globally and inside every Channel. It has control parity: it may initiate every declared Channel Action and Channel Query available to the person, but it has no observation parity because stored and derived values bypass model context. It sees values a person deliberately includes in a prompt, but tools never return Store-derived values to it. It knows schemas and tool contracts, prepares queries, and connects tool calls through Result Handles without depending on how a Store manages data.
_Avoid_: Bot administrator, privileged automation, separate mutation path

**Agent Runtime**:
The environment that interprets a person's prompt and calls Datagram agent tools. Initial runtimes are an API-backed runtime for hosted or background execution and a per-person Codex Runtime for local interactive execution through the official Codex App Server; both use the same zero-data tool contract.
_Avoid_: Data Store, privileged actor, provider-specific domain model

**Codex Runtime**:
An Agent Runtime controlled through the official Codex App Server or SDK and authenticated with the person's ChatGPT plan. Codex owns its login credentials and plan limits; Datagram supplies tools and never treats the subscription as a generic model API key.
_Avoid_: Copied ChatGPT token, shared server credential, OpenAI API substitute

**Automation Principal**:
A non-person permission subject owned by a Workflow Channel. It receives explicit Channel Roles on target Channels so scheduled or triggered runs do not inherit permanent authority from the Workflow creator; each Operation also records the triggering person when one exists.
_Avoid_: Workflow creator, system administrator, anonymous service account

**Result Handle**:
A short-lived opaque reference to data produced or selected by a Datagram tool. It is bound to one Service, actor, and declared purpose, cannot be shared, and is permission-checked on every use. An AI Agent can pass it to another tool for aggregation, mutation, presentation, or Chart creation without receiving underlying values; durable Data Views retain Queries rather than Handles.
_Avoid_: Query result values, copied dataset, model context

**Secret Vault**:
The Service-managed facility that stores integration credentials and releases their effects only through named, permission-checked capabilities. AI Agents, Workflows, and Channel Types never receive the credential value, and each capability use is audited.
_Avoid_: Environment variable exposed to type code, prompt secret, shared plaintext credential

**MCP Gateway**:
The adapter that exposes Datagram Channel Actions and Channel Queries to authenticated agents through MCP. Stores remain internal implementations; external MCP tools may later be reached only through mediated capabilities that preserve permissions and Operations.
_Avoid_: Store adapter, direct database MCP, mutation bypass

**Data View**:
A human-facing value, Table, Chart, or other presentation rendered by a host directly from a Result Handle. An ad-hoc Data View retains its query definition rather than result values and re-executes when reopened; saving it creates an appropriate durable View or Chart Channel. Stored and derived values flow from tools to the host without entering AI Agent context, so the Agent may describe its action but cannot interpret the rendered values.
_Avoid_: Agent response text, model-generated interpretation, copied query result

**Workflow**:
A Channel Entity that invokes Datagram tools through an Automation Principal. The initial Workflow model is a declarative sequence triggered manually, on a schedule, or by Channel Activity, without arbitrary code, loops, or conditional branches.
_Avoid_: In-process script, creator-owned automation, unrestricted plugin

**Workflow Run**:
One execution of a Workflow whose steps each create their own Operation. A failed step stops the run without rolling back completed steps or external effects; only idempotent steps may retry automatically.
_Avoid_: Distributed transaction, invisible retry, single giant Operation

**Store**:
A persistence implementation behind Datagram's storage contract. The first implementations are a Local Store backed by SQLite and a Server Store backed by PostgreSQL; both expose the same Datagram behavior and neither changes the domain model.
_Avoid_: Database-shaped domain model, Channel Type database adapter, synchronized replica

**Capability Sandbox**:
The execution boundary for installed Channel Type logic. Type code cannot access a Store, network, filesystem, or secrets directly and instead uses explicitly declared, permission-checked Datagram capabilities.
_Avoid_: In-process trust, unrestricted plugin runtime, direct infrastructure access

**Realtime Subscription**:
A client connection that receives authorized Channel Activity and Operation-result events after the initial state is loaded. UI, CLI, and other clients use the same event stream; realtime behavior does not depend on a graphical interface.
_Avoid_: UI refresh loop, database change feed, unrestricted event bus

**Global Search**:
A permission-filtered search across accessible Channels and the searchable Fields declared by their Channel Types. Human-facing clients may receive matching values, while an AI Agent receives only schemas, non-data execution status, and Result Handles.
_Avoid_: Database search, privileged search, model data access

**Archived Channel**:
A Channel placed in a person's system Archive group without being deleted or hidden from other people. New unmuted Channel Activity returns it to that person's active list; a muted Archived Channel remains archived.
_Avoid_: Deleted Channel, shared archive state, permanent hide

**Channel Bundle**:
A Store-neutral export package for authorized Channels, their Channel Type definitions or version requirements, and included dependencies. Import reconstructs the included graph; references to excluded Channels remain unresolved. A Channel Bundle is an explicit transfer, not live Store synchronization.
_Avoid_: Database dump, synchronized replica, workspace export

**Service Backup**:
An infrastructure-level snapshot used by a Deployment Operator to restore one complete Datagram Service. It contains all Service data and belongs to the infrastructure trust boundary rather than permission-scoped user export.
_Avoid_: Channel Bundle, selective export, operator-safe metadata

**Purge**:
An explicit destructive Operation that permanently removes previously tombstoned data. The first release performs no automatic purge; configurable retention and automatic cleanup may be added later.
_Avoid_: Delete, Archive, background retention

## Initial Functional Slice

The initial slice is headless. It includes the Datagram Service, Store contract, SQLite Local Store, PostgreSQL Server Store, CLI, MCP Gateway, Codex skill, semantic View Definition validation, and bundled Channel core, Discussion, Table, Dictionary, and Chart behavior. It adds no bespoke UI.

The slice is complete when the same typed contracts can:

1. Create a Table Channel through CLI and prompt.
2. Add typed Fields and Records, including Dictionary validation.
3. Share the Channel with another Service identity and assign a Channel Role.
4. Emit realtime Channel Activity when the other person changes a Record.
5. Query and aggregate Table data without returning Store-derived values to the AI Agent.
6. Create a live Chart Channel from the aggregation and render its semantic View Definition.
7. Produce equivalent Operations, permissions, validation, and audit regardless of CLI, MCP, or agent origin.

Conversation specialization and Workflow execution follow this slice. SQLite is implemented first; PostgreSQL must pass the same Store contract tests before multi-user sharing is considered complete.
