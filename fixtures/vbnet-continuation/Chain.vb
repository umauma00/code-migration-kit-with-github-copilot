' VB 14: a line that starts with "." continues the previous one. Inside
' With, .X is a member of the With object and stays its own statement.
Public Class Chain
    Sub Go()
        Dim r = Maker.Make()
            .Run()
        Dim w As New Widget
        With w
            .P = Nothing
        End With
    End Sub
End Class
