Imports Global.Core
Imports Acme.Billing ' note
Imports Acme _
  .Sales
Namespace Core
  Class A
  End Class
End Namespace
Class U
  Inherits Acme.Base.BaseSvc
  Dim x As A
  Dim i As Acme.Orders.Invoice
  Sub M()
    Dim o = New Acme.Made.Thing()
    If o Is foo.bar.baz Then
    End If
  End Sub
End Class
