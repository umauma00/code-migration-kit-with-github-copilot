' Two Namespace blocks in one file: each Thing resolves from its own block.
Namespace A
    Class First
        Private x As Thing
    End Class
End Namespace

Namespace B
    Class Second
        Private y As Thing
    End Class
End Namespace
