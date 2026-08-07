export const benchmarkQueries = {
  pointLookup: {
    name: "Point lookup",
    query: `
      MATCH (u:User {id: $userId})
      RETURN u.id AS id
    `,
  },

  filteredLookup: {
    name: "Indexed range lookup",
    query: `
      MATCH (u:User)
      WHERE u.id >= $minimumId
        AND u.id < $maximumId
      RETURN count(u) AS matchedUsers
    `,
  },

  oneHop: {
    name: "1-hop traversal",
    query: `
      MATCH (:User {id: $userId})
            -[:VOTED_FOR]->
            (destination:User)
      RETURN count(destination) AS resultCount
    `,
  },

  twoHop: {
    name: "2-hop traversal",
    query: `
      MATCH (:User {id: $userId})
            -[:VOTED_FOR]->
            (:User)
            -[:VOTED_FOR]->
            (destination:User)
      RETURN count(destination) AS resultCount
    `,
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
      RETURN count(destination) AS resultCount
    `,
  },

  aggregation: {
    name: "Vote count aggregation",
    query: `
      MATCH (candidate:User)<-[:VOTED_FOR]-(voter:User)
      RETURN candidate.id AS candidateId,
             count(voter) AS voteCount
      ORDER BY voteCount DESC
      LIMIT 20
    `,
  },
};