' PmCategory is the base type's property.
Public Class PmDerived
    Inherits PmBase
    Function F() As Boolean
        Return PmCategory = "food"
    End Function
End Class
