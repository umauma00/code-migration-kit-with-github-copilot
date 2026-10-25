Imports Shop.Core.Billing

Namespace App
    ' Invoice, Receipt, InvoiceLine, Note and Stamp are never written here:
    ' their files are reached through declared return and member types.
    Public Class Checkout
        Inherits CheckoutBase

        Public Sub Run()
            Dim inv = Factory.CreateInvoice()
            inv.Pay().Print()
            For Each line In inv.Lines
                line.Describe()
            Next
            Audit().Seal()
        End Sub
    End Class
End Namespace
