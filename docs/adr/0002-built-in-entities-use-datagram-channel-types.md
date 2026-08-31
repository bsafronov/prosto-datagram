# Built-in entities use Datagram-owned Channel Types

Conversation, Table, Dictionary, Chart, Workflow, and future built-in Channel Entities use the same versioned Channel Type contract intended for future trusted extensions. Prosto.Datagram owns this contract and runtime independently; it borrows portable-contract ideas from Prosto Designer but does not depend on Designer's Plugin format, Runtime, Marketplace, Profile model, or delivery pipeline. This costs more contract design during the first slice but prevents built-in entity behavior from becoming fixed kernel code.
