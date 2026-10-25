' PmCategory is the property another part of the partial type declares.
Partial Public Class PmProduct
    Public Function IsFood() As Boolean
        Return PmCategory = "food"
    End Function
End Class
