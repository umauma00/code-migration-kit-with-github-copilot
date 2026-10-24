Namespace N
    ' Global. starts from the root namespace: X.Target, never N.X.Target.
    Class Rooted
        Private field As Global.X.Target

        Sub Run()
            Dim t = New Global.X.Target()
        End Sub
    End Class
End Namespace
