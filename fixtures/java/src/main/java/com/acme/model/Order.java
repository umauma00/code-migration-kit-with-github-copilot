package com.acme.model;

import java.util.List;

public class Order {
    private Customer customer;
    private List<Line> lines;

    public Customer getCustomer() { return customer; }
    public List<Line> getLines() { return lines; }

    public record Line(Order order, int qty) { }
}
