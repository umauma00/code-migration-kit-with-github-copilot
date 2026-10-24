       IDENTIFICATION DIVISION.
       PROGRAM-ID. FLAGS.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
      * ON-CALL and WS-COPY are data names, END-CALL a scope terminator.
       01 ON-CALL PIC X.
       01 WS-COPY PIC X.
       PROCEDURE DIVISION.
           IF ON-CALL EQUAL 'Y'
               CALL 'SUBA'
               END-CALL
               MOVE 'N' TO WS-COPY
           END-IF.
           GOBACK.
