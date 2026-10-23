package com.acme.model;

import java.util.List;

public class Order {
    private Customer customer;
    private List<Line> lines;

    public record Line(Order order, int qty) { }
}
