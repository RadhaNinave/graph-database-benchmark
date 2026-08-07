export const ageBenchmarkQueries = {
  pointLookup: {
    name: "Point lookup",
    query: `
      MATCH (u:User {id: $userId})
      RETURN u.id
    `,
    columns: ["id"],
  },

  filteredLookup: {
    name: "Indexed range lookup",
    query: `
      MATCH (u:User)
      WHERE u.id >= $minimumId
        AND u.id < $maximumId
      RETURN count(u)
    `,
    columns: ["matched_users"],
  },

  oneHop: {
    name: "1-hop traversal",
    query: `
      MATCH (:User {id: $userId})
            -[:VOTED_FOR]->
            (destination:User)
      RETURN count(destination)
    `,
    columns: ["result_count"],
  },

  twoHop: {
    name: "2-hop traversal",
    query: `
      MATCH (:User {id: $userId})
            -[:VOTED_FOR]->
            (:User)
            -[:VOTED_FOR]->
            (destination:User)
      RETURN count(destination)
    `,
    columns: ["result_count"],
  },

  threeHop: {
    name: "3-hop traversal",
    query: `
      MATCH (:User {id: $userId})
            -[:VOTED_FOR]->
            (:User)
            -[:VOTED_FOR]->
            (:User)
            -[:VOTED_FOR]->
            (destination:User)
      RETURN count(destination)
    `,
    columns: ["result_count"],
  },

  aggregation: {
    name: "Vote count aggregation",
    query: `
      MATCH (candidate:User)<-[:VOTED_FOR]-(voter:User)
      RETURN
        candidate.id,
        count(voter)
      ORDER BY count(voter) DESC
      LIMIT 20
    `,
    columns: [
      "candidate_id",
      "vote_count",
    ],
  },
};