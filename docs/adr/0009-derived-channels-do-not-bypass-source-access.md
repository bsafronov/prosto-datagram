# Derived Channels do not bypass source access

A live derived Channel, such as a Chart Channel backed by a Table Channel, never grants access to protected source data. A person must have access to both the derived Channel and each live source Channel before results are shown. A future explicit snapshot or publication flow may expose an approved aggregate more broadly, but live derivation is not a permission bypass.
