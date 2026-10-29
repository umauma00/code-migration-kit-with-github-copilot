Imports Shop.Core
Imports Fmt = Shop.Common.Formatter

Namespace App
    ' Customer in a comment is not a reference
    Public Class MainForm
        Private _order As ORDER = New Order()

        Public Sub Run(ByVal args() As String)
            Dim text As String = "new Invoice()"
            Dim total = CalculateTax(10) + _
                Fmt.Width
            Dim x = CreateObject(args(0))
            Dim y = Type.GetType("Shop.Core.Invoice")
            Log("done") : Dim z = "x".Shout()
        End Sub
    End Class
End Namespace
