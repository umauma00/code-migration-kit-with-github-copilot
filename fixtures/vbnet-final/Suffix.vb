' s$ is a String variable (type character), not the start of $"...".
' The braces in the string are text, so Hidden is not a reference.
Class Suffix
    Sub T()
        Dim s$ = "x"
        Dim t = s$&"{Hidden}"
        Dim u As New Shown()
    End Sub
End Class
