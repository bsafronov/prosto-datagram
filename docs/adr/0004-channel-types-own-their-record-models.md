# Channel Types own their record models

Messages, Table Records, Workflow Runs, and other Channel Records share Channels, permissions, Operations, and Channel Activity without sharing one universal stored shape. Each Channel Type owns its record model and invariants. This preserves domain meaning and avoids forcing every interaction into a Table-shaped abstraction while retaining consistent collaboration behavior.
