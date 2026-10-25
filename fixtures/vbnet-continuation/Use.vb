' Widget and Part are never written here: Make's return type and its P.
Public Class Use
    Sub Run()
        Dim w = Factory.Make(1,
                             2)
        w.P.Go()
    End Sub
End Class
