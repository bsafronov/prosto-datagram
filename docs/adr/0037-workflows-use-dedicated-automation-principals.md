# Workflows use dedicated Automation Principals

Each Workflow Channel owns an Automation Principal that receives explicit Channel Roles on Channels it may use. Workflow runs do not permanently inherit the creator's authority and can continue safely if that person leaves. Every resulting Operation records the Workflow and Automation Principal and also records the triggering person when a run was started by a person.
