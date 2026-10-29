' The local pvorder of A is not in view in B: PvOrder.Create() there is the
' class, and its PvInvoice is reached.
Public Class PvSvc
    Public Sub A()
        Dim pvorder As String = "x"
    End Sub
    Public Sub B()
        Dim t = PvOrder.Create().Total
    End Sub
End Class
