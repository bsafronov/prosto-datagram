# Dictionaries are dedicated Channel Entities

A Dictionary is a Channel Entity containing uniquely identified Dictionary Entries and is primarily consumed by Dictionary Fields in Tables. Dictionary Fields store Entry identities and validate that each referenced Entry belongs to the selected Dictionary; labels are not copied into Table Records. This gives shared values their own collaboration, permissions, Activity, and lifecycle instead of treating each Table as the owner of an embedded option list.
