package com.acme.app;

import com.acme.model.Order;
import com.acme.model.Missing;
import com.acme.util.*;
import static com.acme.util.Strings.shout;

/** Customer in a comment is not a reference. */
public class Main {
    public static void main(String[] args) throws Exception {
        Order order = new Order();
        String s = shout("text with Customer inside");
        Object reflected = Class.forName("com.acme.model.Customer");
        Object computed = Class.forName(args[0]);
        String block = """
            new Invoice()
            """;
        System.out.println(Main.class.getName() + Helper.VERSION + s);
        new com.acme.model.Invoice();
    }
}
