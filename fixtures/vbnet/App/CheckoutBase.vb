Imports Shop.Core.Billing

Namespace App
    Public MustInherit Class CheckoutBase
        Protected Function Audit() As Stamp
            Return New Stamp()
        End Function
    End Class
End Namespace
