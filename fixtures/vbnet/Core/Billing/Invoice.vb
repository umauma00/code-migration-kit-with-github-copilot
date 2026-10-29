Imports System.Collections.Generic

Namespace Core.Billing
    Public Class Invoice
        Public ReadOnly Property Lines As List(Of InvoiceLine)

        Public Function Pay() As Receipt
            Return New Receipt()
        End Function
    End Class
End Namespace
