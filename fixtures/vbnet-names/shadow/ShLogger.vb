' Parameters, locals, lambda parameters, members and named arguments
' spelled like the class ShMessage are not references to it.
Public Class ShLogger
    Public Property ShOrder As Integer
    Public Sub Log(shmessage As String)
        Console.WriteLine(shmessage)
        If shmessage.Length > 3 Then Console.WriteLine(shmessage.ToUpper())
    End Sub
    Sub Count(l As System.Collections.Generic.List(Of Integer))
        Dim total As Integer = 0
        l.ForEach(Sub(shmessage) total += shmessage)
        Make(shmessage:=1)
    End Sub
    Sub Make(Optional shmessage As Integer = 0)
    End Sub
End Class
