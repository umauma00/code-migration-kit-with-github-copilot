' A variable named like its type: the type written in a conversion, after
' TypeOf ... Is or in (Of ...) is still a dependency.
Public Class CsForm
    Private Sub Pick(o As Object)
        Dim cscustomer = DirectCast(o, CsCustomer)
        Dim csorder = TryCast(o, CsOrder)
        Dim csline As New System.Collections.Generic.Dictionary(Of Integer, CsLine)
        Dim cstag = o
        If TypeOf cstag Is CsTag Then Return
    End Sub
End Class
