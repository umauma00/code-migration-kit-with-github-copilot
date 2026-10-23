Imports System.Runtime.CompilerServices

Public Module TaxModule
    Public Const Rate As Decimal = 0.1D

    Public Function CalculateTax(ByVal amount As Decimal) As Decimal
        Dim localOnly As Decimal = amount * Rate
        Return localOnly
    End Function

    <Extension()>
    Public Function Shout(ByVal s As String) As String
        Return s.ToUpper()
    End Function

    Sub Log(ByVal message As String)
    End Sub
End Module
