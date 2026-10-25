' A real use in a procedure with no local of that name, and type positions.
Public Class ShUser
    Sub A(shmessage As Integer)
        shmessage += 1
    End Sub
    Sub B()
        Dim m = ShMessage.Create()
    End Sub
End Class
